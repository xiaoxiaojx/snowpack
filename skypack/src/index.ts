import cacache from 'cacache';
import got, {Response} from 'got';
import {IncomingHttpHeaders} from 'http';
import {RESOURCE_CACHE, SKYPACK_ORIGIN, parseRawPackageImport} from './util';

interface ResourceCacheMetadata {
  headers: IncomingHttpHeaders;
  statusCode: number;
  freshUntil: string;
}

export async function fetchCDN(
  resourceUrl: string,
): Promise<{
  body: string;
  headers: IncomingHttpHeaders;
  statusCode: number;
  isCached: boolean;
  isStale: boolean;
}> {
  if (!resourceUrl.startsWith(SKYPACK_ORIGIN)) {
    resourceUrl = SKYPACK_ORIGIN + resourceUrl;
  }

  const cachedResult = await cacache.get(RESOURCE_CACHE, resourceUrl).catch(() => null);
  if (cachedResult) {
    const cachedResultMetadata = cachedResult.metadata as ResourceCacheMetadata;
    const freshUntil = new Date(cachedResult.metadata.freshUntil);
    if (freshUntil >= new Date()) {
      return {
        isCached: true,
        isStale: false,
        body: cachedResult.data.toString(),
        headers: cachedResultMetadata.headers,
        statusCode: cachedResultMetadata.statusCode,
      };
    }
  }

  let freshResult: Response<string>;
  try {
    freshResult = await got(resourceUrl, {
      headers: {'user-agent': `snowpack/v3.0 (https://www.snowpack.dev)`},
      throwHttpErrors: false,
    });
  } catch (err) {
    if (cachedResult) {
      const cachedResultMetadata = cachedResult.metadata as ResourceCacheMetadata;
      return {
        isCached: true,
        isStale: true,
        body: cachedResult.data.toString(),
        headers: cachedResultMetadata.headers,
        statusCode: cachedResultMetadata.statusCode,
      };
    }
    throw err;
  }

  const cacheUntilMatch = freshResult.headers['cache-control']?.match(/max-age=(\d+)/);
  if (cacheUntilMatch) {
    var freshUntil = new Date();
    freshUntil.setSeconds(freshUntil.getSeconds() + parseInt(cacheUntilMatch[1]));
    // no need to await, since we `.catch()` to swallow any errors.
    cacache
      .put(RESOURCE_CACHE, resourceUrl, freshResult.body, {
        metadata: {
          headers: freshResult.headers,
          statusCode: freshResult.statusCode,
          freshUntil: freshUntil.toUTCString(),
        } as ResourceCacheMetadata,
      })
      .catch(() => null);
  }

  return {
    body: freshResult.body as string,
    headers: freshResult.headers,
    statusCode: freshResult.statusCode,
    isCached: false,
    isStale: false,
  };
}

export type LookupBySpecifierResponse =
  | {error: Error}
  | {
      error: null;
      body: string;
      isCached: boolean;
      isStale: boolean;
      importStatus: string;
      importUrl: string;
      pinnedUrl: string | undefined;
      typesUrl: string | undefined;
    };

export async function lookupBySpecifier(
  spec: string,
  semverMap: Record<string, string> | null,
): Promise<LookupBySpecifierResponse> {
  const [packageName, packagePath] = parseRawPackageImport(spec);
  const semverString = semverMap && semverMap[packageName];
  const lookupUrl =
    `/${packageName}` +
    (semverString ? `@${semverString}` : ``) +
    (packagePath ? `/${packagePath}` : ``);
  try {
    const {body, headers, isCached, isStale} = await fetchCDN(lookupUrl);
    return {
      error: null,
      body,
      isCached,
      isStale,
      importStatus: headers['x-import-status'] as string,
      importUrl: headers['x-import-url'] as string,
      pinnedUrl: headers['x-pinned-url'] as string | undefined,
      typesUrl: headers['x-typescript-types'] as string | undefined,
    };
  } catch (err) {
    return {error: err};
  }
}

export type LoadByUrlResponse =
  | {error: Error}
  | {
      error: null;
      body: string;
      isCached: boolean;
      isStale: boolean;
    };

export async function loadByUrl(url: string): Promise<LoadByUrlResponse> {
  try {
    const {body, isCached, isStale} = await fetchCDN(url);
    return {error: null, body, isCached, isStale};
  } catch (err) {
    return {error: err};
  }
}

export async function clearCache() {
  return Promise.all([cacache.rm.all(RESOURCE_CACHE)]);
}


export async function cli(args: string[]) {
  console.log(args);
}
