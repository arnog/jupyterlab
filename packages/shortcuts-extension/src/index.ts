// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterLab, JupyterLabPlugin } from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/coreutils';

import { CommandRegistry } from '@phosphor/commands';

import {
  JSONExt,
  ReadonlyJSONObject,
  ReadonlyJSONValue
} from '@phosphor/coreutils';

import { DisposableSet, IDisposable } from '@phosphor/disposable';

/**
 * This plugin and its schema are deprecated and will be removed in a future
 * version of JupyterLab. This plugin will load old keyboard shortcuts and add
 * them to the new keyboard shortcuts plugin below before removing the old
 * shortcuts.
 */
const plugin: JupyterLabPlugin<void> = {
  id: '@jupyterlab/shortcuts-extension:plugin',
  requires: [ISettingRegistry],
  activate: async (app: JupyterLab, registry: ISettingRegistry) => {
    try {
      const settings = await registry.load(plugin.id);

      // TODO
      // Handle old-style shortcuts by loading them into the new plugin.
      console.log(`${plugin.id}`, settings.user);
    } catch (error) {
      console.error(`Loading ${plugin.id} failed.`, error);
    }
  },
  autoStart: true
};

/**
 * The default shortcuts extension.
 *
 * #### Notes
 * Shortcut values are stored in the setting system. The default values for each
 * shortcut are preset in the settings schema file of this extension.
 * Additionally, each shortcut can be individually set by the end user by
 * modifying its setting (either in the text editor or by modifying its
 * underlying JSON schema file).
 *
 * When setting shortcut selectors, there are two concepts to consider:
 * specificity and matchability. These two interact in sometimes
 * counterintuitive ways. Keyboard events are triggered from an element and
 * they propagate up the DOM until they reach the `documentElement` (`<body>`).
 *
 * When a registered shortcut sequence is fired, the shortcut manager checks
 * the node that fired the event and each of its ancestors until a node matches
 * one or more registered selectors. The *first* matching selector in the
 * chain of ancestors will invoke the shortcut handler and the traversal will
 * end at that point. If a node matches more than one selector, the handler for
 * whichever selector is more *specific* fires.
 * @see https://www.w3.org/TR/css3-selectors/#specificity
 *
 * The practical consequence of this is that a very broadly matching selector,
 * e.g. `'*'` or `'div'` may match and therefore invoke a handler *before* a
 * more specific selector. The most common pitfall is to use the universal
 * (`'*'`) selector. For almost any use case where a global keyboard shortcut is
 * required, using the `'body'` selector is more appropriate.
 */
const shortcuts: JupyterLabPlugin<void> = {
  id: '@jupyterlab/shortcuts-extension:shortcuts',
  requires: [ISettingRegistry],
  activate: async (app: JupyterLab, registry: ISettingRegistry) => {
    const { commands } = app;
    let canonical: ISettingRegistry.ISchema;
    let loaded: { [name: string]: null } = {};

    /**
     * Populate the plugin's schema defaults.
     */
    function populate(schema: ISettingRegistry.ISchema) {
      loaded = {};
      schema.properties.shortcuts.default = Object.keys(registry.plugins)
        .map(plugin => {
          loaded[plugin] = null;
          return registry.plugins[plugin];
        })
        .reduce(
          (acc, val) => acc.concat(val.schema['jupyter.lab.shortcuts'] || []),
          []
        )
        .sort((a, b) => a.command.localeCompare(b.command));
    }

    registry.pluginChanged.connect((sender, plugin) => {
      if (!(plugin in loaded)) {
        populate(canonical);
      }
    });

    // Transform the plugin object to return different schema than the default.
    registry.transform(shortcuts.id, {
      compose: plugin => {
        // Only override the canonical schema the first time.
        if (!canonical) {
          canonical = JSONExt.deepCopy(plugin.schema);
          populate(canonical);
        }

        const defaults = canonical.properties.shortcuts.default;
        const user = {
          shortcuts: ((plugin.data && plugin.data.user) || {}).shortcuts || []
        };
        const composite = {
          shortcuts: Private.merge(
            defaults,
            user.shortcuts as ISettingRegistry.IShortcut[]
          )
        };

        plugin.data = { composite, user };

        return plugin;
      },
      fetch: plugin => {
        // Only override the canonical schema the first time.
        if (!canonical) {
          canonical = JSONExt.deepCopy(plugin.schema);
          populate(canonical);
        }

        return {
          data: plugin.data,
          id: plugin.id,
          raw: plugin.raw,
          schema: canonical,
          version: plugin.version
        };
      }
    });

    try {
      const settings = await registry.load(shortcuts.id);

      Private.loadShortcuts(commands, settings.composite);
      settings.changed.connect(() => {
        Private.loadShortcuts(commands, settings.composite);
      });
    } catch (error) {
      console.error(`Loading ${shortcuts.id} failed.`, error);
    }
  },
  autoStart: true
};

/**
 * Export the plugins as default.
 */
const plugins: JupyterLabPlugin<any>[] = [plugin, shortcuts];

export default plugins;

/**
 * A namespace for private module data.
 */
namespace Private {
  /**
   * The internal collection of currently loaded shortcuts.
   */
  let disposables: IDisposable;

  /**
   * Load the keyboard shortcuts from settings.
   */
  export function loadShortcuts(
    commands: CommandRegistry,
    composite: ReadonlyJSONObject
  ): void {
    const shortcuts = composite.shortcuts as ISettingRegistry.IShortcut[];

    if (disposables) {
      disposables.dispose();
    }
    disposables = shortcuts.reduce((acc, val): DisposableSet => {
      const options = normalizeOptions(val);

      if (options) {
        acc.add(commands.addKeyBinding(options));
      }

      return acc;
    }, new DisposableSet());
  }

  /**
   * Reconcile the default shortcuts and user shortcuts.
   */
  export function merge(
    defaults: ISettingRegistry.IShortcut[],
    user: ISettingRegistry.IShortcut[]
  ): ISettingRegistry.IShortcut[] {
    const memo: {
      [keys: string]: {
        [selector: string]: boolean; // If `true`, this is a default shortcut.
      };
    } = {};
    const warning = 'Shortcut skipped due to collision.';

    // If a user shortcut collides with another user shortcut warn and filter.
    user = user.filter(shortcut => {
      const keys = shortcut.keys.join('\n');
      const { selector } = shortcut;

      if (!(keys in memo)) {
        memo[keys] = {};
      }
      if (!(selector in memo[keys])) {
        memo[keys][selector] = false; // User shortcuts are `false`.
        return true;
      }

      console.warn(warning, shortcut);
      return false;
    });

    // If a default shortcut collides with another default, warn and filter.
    // If a shortcut has already been added by the user preferences, filter it
    // out too.
    defaults = defaults.filter(shortcut => {
      const { disabled } = shortcut;

      if (disabled) {
        return false;
      }

      const keys = shortcut.keys.join('\n');

      if (keys === '') {
        return false;
      }
      if (!(keys in memo)) {
        memo[keys] = {};
      }

      const { selector } = shortcut;

      if (!(selector in memo[keys])) {
        memo[keys][selector] = true; // Default shortcuts are `true`.
        return true;
      }

      // Only warn if a default shortcut collides with another default shortcut.
      if (memo[keys][selector]) {
        console.warn(warning, shortcut);
      }

      return false;
    });

    // Filter out disabled user shortcuts and concat defaults before returning.
    return user.filter(shortcut => !shortcut.disabled).concat(defaults);
  }

  /**
   * Normalize potential keyboard shortcut options.
   */
  function normalizeOptions(
    value: ReadonlyJSONValue | Partial<CommandRegistry.IKeyBindingOptions>
  ): CommandRegistry.IKeyBindingOptions | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const { isArray } = Array;
    const valid =
      'command' in value &&
      'keys' in value &&
      'selector' in value &&
      isArray((value as Partial<CommandRegistry.IKeyBindingOptions>).keys);

    return valid ? (value as CommandRegistry.IKeyBindingOptions) : undefined;
  }
}
