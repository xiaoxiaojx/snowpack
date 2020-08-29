import cacache from 'cacache';
import * as colors from 'kleur/colors';
import {logger} from './logger';
import {ImportMap, SnowpackConfig} from './types/snowpack';
import {fetchCDNResource, PIKA_CDN, RESOURCE_CACHE} from './util.js';
import PQueue from 'p-queue/dist';

/**
 * Given an install specifier, attempt to resolve it from the CDN.
 * If no lockfile exists or if the entry is not found in the lockfile, attempt to resolve
 * it from the CDN directly. Otherwise, use the URL found in the lockfile and attempt to
 * check the local cache first.
 *
 * All resolved URLs are populated into the local cache, where our internal Rollup engine
 * will load them from when it installs your dependencies to disk.
 */
export async function resolveDependencyByName(
  installSpecifier: string,
  packageSemver: string,
  lockfile: ImportMap | null,
  canRetry = true,
): Promise<{body: string, pinnedUrl: string}> {
  // Grab the installUrl from our lockfile if it exists, otherwise resolve it yourself.
  let installUrl: string;
  let installUrlType: 'pin' | 'lookup';

  if (lockfile && lockfile.imports[installSpecifier]) {
    installUrl = lockfile.imports[installSpecifier];
    installUrlType = 'pin';
  } else {
    if (packageSemver === 'latest') {
      logger.warn(
        `warn(${installSpecifier}): Not found in "dependencies". Using latest package version...`,
      );
    }
    if (packageSemver.startsWith('npm:@reactesm') || packageSemver.startsWith('npm:@pika/react')) {
      throw new Error(
        `React workaround packages no longer needed! Revert to the official React & React-DOM packages.`,
      );
    }
    if (packageSemver.includes(' ') || packageSemver.includes(':')) {
      throw new Error(
        `warn(${installSpecifier}): Can't fetch complex semver "${packageSemver}" from remote CDN.`,
      );
    }
    installUrlType = 'lookup';
    installUrl = `${PIKA_CDN}/${installSpecifier}@${packageSemver}`;
  }

  // Hashed CDN urls never change, so its safe to grab them directly from the local cache
  // without a network request.
  if (installUrlType === 'pin') {
    return resolveDependencyByUrl(installUrl);
  }

  // Otherwise, resolve from the CDN remotely.
  const {statusCode, headers, body} = await fetchCDNResource(installUrl);
  if (statusCode !== 200) {
      throw new Error(
        `Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
  }

  let importUrlPath = headers['x-import-url'] as string;
  let pinnedUrlPath = headers['x-pinned-url'] as string;
  const buildStatus = headers['x-import-status'] as string;

  if (buildStatus === 'SUCCESS') {
    return {body: body as string, pinnedUrl: `${PIKA_CDN}${pinnedUrlPath}`};
  }
  if (!canRetry || buildStatus === 'FAIL') {
    throw new Error(
      `Failed to build: ${installSpecifier}@${packageSemver}`);
  }
  logger.info(
    colors.cyan(
      `Building ${installSpecifier}@${packageSemver}... (This takes a moment, but will be cached for future use)`,
    ),
  );
  if (!importUrlPath) {
    throw new Error(
    'X-Import-URL header expected, but none received.');
  }
  const {statusCode: lookupStatusCode} = await fetchCDNResource(importUrlPath);
  if (lookupStatusCode !== 200) {
    throw new Error(
    `Unexpected response [${lookupStatusCode}]: ${PIKA_CDN}${importUrlPath}`);
  }
  return resolveDependencyByName(installSpecifier, packageSemver, lockfile, false);
}

/**
 * Given an install specifier, attempt to resolve it from the CDN.
 * If no lockfile exists or if the entry is not found in the lockfile, attempt to resolve
 * it from the CDN directly. Otherwise, use the URL found in the lockfile and attempt to
 * check the local cache first.
 *
 * All resolved URLs are populated into the local cache, where our internal Rollup engine
 * will load them from when it installs your dependencies to disk.
 */
export async function resolveDependencyByUrl(installUrl: string): Promise<{body: string, pinnedUrl: string}> {
  if (!installUrl.startsWith(PIKA_CDN)) {
    installUrl = PIKA_CDN + installUrl;
  }
  // Hashed CDN urls never change, so its safe to grab them directly from the local cache
  // without a network request.
  const cachedResult = await cacache.get(RESOURCE_CACHE, installUrl).catch(() => null);
  if (cachedResult) {
    return {body: cachedResult.data.toString('utf-8'), pinnedUrl: cachedResult.metadata.pinnedUrl};
  }

  // Otherwise, resolve from the CDN remotely.
  const {statusCode, headers, body} = await fetchCDNResource(installUrl);
  if (statusCode !== 200) {
    logger.warn(`Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
    throw new Error(`Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
  }

  const typesUrlPath = headers['x-typescript-types'] as string | undefined;
  const typesUrl = typesUrlPath && `${PIKA_CDN}${typesUrlPath}`;

  if (headers['cache-control']?.includes('max-age=')) {
    await cacache.put(RESOURCE_CACHE, installUrl, body, {
      metadata: {installUrl, typesUrl},
    });
  }
    return {body: body as string, pinnedUrl: installUrl};
}

export async function generateNewLockfile(
  lockfile: ImportMap | null,
  config: SnowpackConfig,
) {
  const downloadQueue = new PQueue({concurrency: 16});
  const newLockfile: ImportMap = {imports: {}};
  let resolutionError: Error | undefined;

  for (const [installSpecifier, installSemver] of Object.entries(config.webDependencies!)) {
    downloadQueue.add(async () => {
      try {
        const {pinnedUrl} = await resolveDependencyByName(installSpecifier, installSemver, lockfile);
        newLockfile.imports[installSpecifier] = pinnedUrl;
      } catch (err) {
        resolutionError = resolutionError || err;
      }
    });
  }

  await downloadQueue.onIdle();
  if (resolutionError) {
    throw resolutionError;
  }

  return newLockfile;
}
