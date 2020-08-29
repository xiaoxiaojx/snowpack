import cacache from 'cacache';
import * as colors from 'kleur/colors';
import PQueue from 'p-queue/dist';
import got, {Response} from 'got';
import { PIKA_CDN, RESOURCE_CACHE } from './util';
import { ImportMap } from './types';

export {run} from './install';

const inMemoryCDNCache = new Map<string, Response>();
export async function fetchCDNResource(
  resourceUrl: string,
  responseType?: 'text' | 'json' | 'buffer',
): Promise<Response> {
  if (!resourceUrl.startsWith(PIKA_CDN)) {
    resourceUrl = PIKA_CDN + resourceUrl;
  }
  if (inMemoryCDNCache.has(resourceUrl)) {
    return inMemoryCDNCache.get(resourceUrl)!;
  }
  const response = await got(resourceUrl, {
    responseType: responseType,
    headers: {'user-agent': `snowpack/v1.4 (https://snowpack.dev)`},
    throwHttpErrors: false,
  });
  if (response.headers?.['cache-control']?.includes('max-age=')) {
    inMemoryCDNCache.set(resourceUrl, response);
  }
  return response;
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
export async function resolveDependencyByName(
  installSpecifier: string,
  packageSemver: string,
  lockfile: ImportMap | null,
  canRetry = true,
): Promise<{body: string; pinnedUrl: string}> {
  // Grab the installUrl from our lockfile if it exists, otherwise resolve it yourself.
  let installUrl: string;
  let installUrlType: 'pin' | 'lookup';

  // WIP-REMOTE TODO (but prob not here): how do we handle import maps for things like "svelte/internal"
  // If we follow spec, we need an import map entry for each specifier:
  //      This means dev workflow needs a way to add lockfile entries. How do we keep this manageable?
  // If we break from spec a bit, we can use a parent entry:
  //       Problem is how do we get the proper entry URL in that case?

  if (lockfile && lockfile.imports[installSpecifier]) {
    installUrl = lockfile.imports[installSpecifier];
    installUrlType = 'pin';
  } else {
    if (packageSemver === 'latest') {
      console.warn(
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
    // Annoying logic to add the "latest" string at the right place for scopes vs. non-scoped packages
    const [specPart1, specPart2, ...specParts] = installSpecifier.split('/');
    if (specPart1.startsWith('@')) {
      installUrl = `${PIKA_CDN}/${specPart1}/${specPart2}@${packageSemver}${specParts.filter(Boolean).map(
        (p) => '/' + p,
      )}`;
    } else {
      installUrl = `${PIKA_CDN}/${specPart1}@${packageSemver}${[specPart2, ...specParts].filter(Boolean).map(
        (p) => '/' + p,
      )}`;
    }
  }

  // Hashed CDN urls never change, so its safe to grab them directly from the local cache
  // without a network request.
  if (installUrlType === 'pin') {
    return resolveDependencyByUrl(installUrl);
  }

  // Otherwise, resolve from the CDN remotely.
  const {statusCode, headers, body} = await fetchCDNResource(installUrl);
  if (statusCode !== 200) {
    throw new Error(`Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
  }

  let importUrlPath = headers['x-import-url'] as string;
  let pinnedUrlPath = headers['x-pinned-url'] as string;
  const buildStatus = headers['x-import-status'] as string;

  if (buildStatus === 'SUCCESS') {
    return {body: body as string, pinnedUrl: `${PIKA_CDN}${pinnedUrlPath}`};
  }
  if (!canRetry || buildStatus === 'FAIL') {
    throw new Error(`Failed to build: ${installSpecifier}@${packageSemver}`);
  }
  console.log(
    colors.cyan(
      `Building ${installSpecifier}@${packageSemver}... (This takes a moment, but will be cached for future use)`,
    ),
  );
  if (!importUrlPath) {
    throw new Error('X-Import-URL header expected, but none received.');
  }
  const {statusCode: lookupStatusCode} = await fetchCDNResource(importUrlPath);
  if (lookupStatusCode !== 200) {
    throw new Error(`Unexpected response [${lookupStatusCode}]: ${PIKA_CDN}${importUrlPath}`);
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
export async function resolveDependencyByUrl(
  installUrl: string,
): Promise<{body: string; pinnedUrl: string}> {
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
    console.warn(`Failed to resolve [${statusCode}]: ${installUrl} (${body})`);
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

export async function generateImportMap(
  webDependencies: Record<string, string>,
  lockfile: ImportMap | null,
) {
  const downloadQueue = new PQueue({concurrency: 16});
  const newLockfile: ImportMap = {imports: {}};
  let resolutionError: Error | undefined;

  for (const [installSpecifier, installSemver] of Object.entries(webDependencies)) {
    downloadQueue.add(async () => {
      try {
        const {pinnedUrl} = await resolveDependencyByName(
          installSpecifier,
          installSemver,
          lockfile,
        );
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

export async function clearCache() {
  return Promise.all([cacache.rm.all(RESOURCE_CACHE)]);
}


export async function cli(args: string[]) {
  console.log(args);
}
