import fs from 'fs';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import path from 'path';
import {performance} from 'perf_hooks';
import rimraf from 'rimraf';
import {InputOptions, OutputOptions, rollup, RollupError} from 'rollup';
import validatePackageName from 'validate-npm-package-name';
import {logger} from '../logger';
import {rollupPluginDependencyCache} from '../rollup-plugins/rollup-plugin-remote-cdn.js';
import {rollupPluginDependencyStats} from '../rollup-plugins/rollup-plugin-stats.js';
import {rollupPluginWrapInstallTargets} from '../rollup-plugins/rollup-plugin-wrap-install-targets';
import {
  CommandOptions,
  DependencyStatsOutput,
  ImportMap,
  InstallTarget,
  SnowpackConfig,
} from '../types/snowpack';
import {
  findMatchingAliasEntry,
  MISSING_PLUGIN_SUGGESTIONS,
  sanitizePackageName,
  writeLockfile,
} from '../util.js';

// Add popular CJS packages here that use "synthetic" named imports in their documentation.
// CJS packages should really only be imported via the default export:
//   import React from 'react';
// But, some large projects use named exports in their documentation:
//   import {useState} from 'react';
//
// We use "/index.js here to match the official package, but not any ESM aliase packages
// that the user may have installed instead (ex: react-esm).
const CJS_PACKAGES_TO_AUTO_DETECT = [
  'react/index.js',
  'react-dom/index.js',
  'react-dom/server.js',
  'react-is/index.js',
  'prop-types/index.js',
  'scheduler/index.js',
  'react-table',
];

const cwd = process.cwd();
let dependencyStats: DependencyStatsOutput | null = null;

function isImportOfPackage(importUrl: string, packageName: string) {
  return packageName === importUrl || importUrl.startsWith(packageName + '/');
}

/**
 * Formats the snowpack dependency name from a "webDependencies" input value:
 * 2. Remove any ".js"/".mjs" extension (will be added automatically by Rollup)
 */
function getWebDependencyName(dep: string): string {
  return validatePackageName(dep).validForNewPackages
    ? dep.replace(/\.js$/i, 'js') // if this is a top-level package ending in .js, replace with js (e.g. tippy.js -> tippyjs)
    : dep.replace(/\.m?js$/i, ''); // otherwise simply strip the extension (Rollup will resolve it)
}

interface InstallOptions {
  lockfile: ImportMap | null;
  config: SnowpackConfig;
}

type InstallResult = {success: false; importMap: null} | {success: true; importMap: ImportMap};

const FAILED_INSTALL_MESSAGE = 'Install failed.';
async function install(
  installTargets: InstallTarget[],
  {lockfile, config}: InstallOptions,
): Promise<InstallResult> {
  const {
    installOptions: {
      installTypes,
      dest: destLoc,
      externalPackage: externalPackages,
      sourceMap,
      treeshake: isTreeshake,
    },
  } = config;

  const allInstallSpecifiers = new Set(
    installTargets
      .filter(
        (dep) =>
          !externalPackages.some((packageName) => isImportOfPackage(dep.specifier, packageName)),
      )
      .map((dep) => dep.specifier)
      .map((specifier) => {
        const aliasEntry = findMatchingAliasEntry(config, specifier);
        return aliasEntry && aliasEntry.type === 'package' ? aliasEntry.to : specifier;
      })
      .sort(),
  );
  const installEntrypoints: {[targetName: string]: string} = {};
  const assetEntrypoints: {[targetName: string]: string} = {};
  const importMap: ImportMap = {imports: {}};
  const autoDetectNamedExports = [
    ...CJS_PACKAGES_TO_AUTO_DETECT,
    ...config.installOptions.namedExports,
  ];

  for (const installSpecifier of allInstallSpecifiers) {
    const targetName = getWebDependencyName(installSpecifier);
    const proxiedName = sanitizePackageName(targetName); // sometimes we need to sanitize webModule names, as in the case of tippy.js -> tippyjs
    if (lockfile && lockfile.imports[installSpecifier]) {
      installEntrypoints[targetName] = lockfile.imports[installSpecifier];
      importMap.imports[installSpecifier] = `./${proxiedName}.js`;
    } else {
      throw new Error(`WIP: Dependency ${installSpecifier} must exist in lockfile to build. Run "add" command.`);
    }
  }

  const inputOptions: InputOptions = {
    input: installEntrypoints,
    treeshake: {moduleSideEffects: 'no-external'},
    preserveEntrySignatures: 'allow-extension',
    plugins: [
      rollupPluginDependencyCache({
        installTypes,
      }),
      rollupPluginWrapInstallTargets(!!isTreeshake, autoDetectNamedExports, installTargets),
      rollupPluginDependencyStats((info) => (dependencyStats = info)),
    ].filter(Boolean) as Plugin[],
  };
  const outputOptions: OutputOptions = {
    dir: destLoc,
    format: 'esm',
    sourcemap: sourceMap,
    exports: 'named',
    chunkFileNames: 'common/[name]-[hash].js',
  };
  if (Object.keys(installEntrypoints).length > 0) {
    try {
      const packageBundle = await rollup(inputOptions);
      logger.debug(
        `installing npm packages:\n    ${Object.keys(installEntrypoints).join('\n    ')}`,
      );
      await packageBundle.write(outputOptions);
    } catch (_err) {
      const err: RollupError = _err;
      const errFilePath = err.loc?.file || err.id;
      if (!errFilePath) {
        throw err;
      }
      // NOTE: Rollup will fail instantly on most errors. Therefore, we can
      // only report one error at a time. `err.watchFiles` also exists, but
      // for now `err.loc.file` and `err.id` have all the info that we need.
      const failedExtension = path.extname(errFilePath);
      const suggestion = MISSING_PLUGIN_SUGGESTIONS[failedExtension] || err.message;
      // Display posix-style on all environments, mainly to help with CI :)
      const fileName = path.relative(cwd, errFilePath).replace(/\\/g, '/');
      logger.error(`Failed to load ${colors.bold(fileName)}\n  ${suggestion}`);
      throw new Error(FAILED_INSTALL_MESSAGE);
    }
  }

  mkdirp.sync(destLoc);
  await writeLockfile(path.join(destLoc, 'import-map.json'), importMap);
  for (const [assetName, assetLoc] of Object.entries(assetEntrypoints)) {
    const assetDest = `${destLoc}/${sanitizePackageName(assetName)}`;
    mkdirp.sync(path.dirname(assetDest));
    fs.copyFileSync(assetLoc, assetDest);
  }

  return {
    success: true,
    importMap,
  };
}

interface InstallRunOptions extends CommandOptions {
  installTargets: InstallTarget[];
}

interface InstallRunResult {
  success: boolean;
  hasError: boolean;
  importMap: ImportMap | null;
  stats: DependencyStatsOutput | null;
}

export async function run({
  config,
  lockfile,
  installTargets,
}: InstallRunOptions): Promise<InstallRunResult> {
  const {
    installOptions: {dest},
  } = config;

  // start
  const installStart = performance.now();
  logger.info(colors.yellow('! installing dependencies…'));

  dependencyStats = null;

  if (installTargets.length === 0) {
    return {
      success: true,
      hasError: false,
      importMap: {imports: {}} as ImportMap,
      stats: null,
    };
  }

  rimraf.sync(dest);
  const finalResult = await install(installTargets, {
    lockfile,
    config,
  }).catch((err) => {
    if (err.loc) {
      logger.error(colors.red(colors.bold(`✘ ${err.loc.file}`)));
    }
    if (err.url) {
      logger.error(colors.dim(`👉 ${err.url}`));
    }
    logger.error(err.message || err);
    process.exit(1);
  });

  // finish
  const installEnd = performance.now();
  const depList = (finalResult.importMap && Object.keys(finalResult.importMap.imports)) || [];
  logger.info(
    `${
      depList.length
        ? colors.green(`✔`) + ' install complete'
        : 'install skipped (nothing to install)'
    } ${colors.dim(`[${((installEnd - installStart) / 1000).toFixed(2)}s]`)}`,
  );

  return {
    success: true,
    hasError: false,
    importMap: finalResult.importMap,
    stats: dependencyStats!,
  };
}
