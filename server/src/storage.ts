import { AwsClient } from 'aws4fetch';

// R2 over the S3 API. Objects are private: the only way to read one is a short-lived signed URL
// that this server issues after checking the session.
export type Storage = {
  configured: boolean;
  put(key: string, body: string, contentType: string): Promise<void>;
  signedUrl(key: string, seconds: number): Promise<string>;
  remove(keys: string[]): Promise<void>;
};

type StorageConfig = { R2_ENDPOINT?: string; R2_BUCKET?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string };

export function createStorage(config: StorageConfig, fetchImpl: typeof fetch = fetch): Storage {
  const configured = Boolean(config.R2_ENDPOINT && config.R2_BUCKET && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY);
  const client = configured
    ? new AwsClient({ accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY!, service: 's3', region: 'auto' })
    : null;
  // Keys are built by the server from ids it generated, never from anything a model or visitor wrote.
  const objectUrl = (key: string) => `${config.R2_ENDPOINT!.replace(/\/$/, '')}/${config.R2_BUCKET}/${key}`;

  return {
    configured,
    async put(key, body, contentType) {
      if (!client) throw new Error('Artifact storage is not configured');
      const response = await fetchImpl(await client.sign(objectUrl(key), {
        method: 'PUT', body, headers: { 'Content-Type': contentType },
      }), { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Artifact upload failed (${response.status})`);
    },
    async signedUrl(key, seconds) {
      if (!client) throw new Error('Artifact storage is not configured');
      const signed = await client.sign(`${objectUrl(key)}?X-Amz-Expires=${seconds}&response-content-disposition=attachment`, { method: 'GET', aws: { signQuery: true } });
      return signed.url;
    },
    async remove(keys) {
      if (!client || !keys.length) return;
      await Promise.all(keys.map(async key => {
        const response = await fetchImpl(await client.sign(objectUrl(key), { method: 'DELETE' }), { signal: AbortSignal.timeout(20000) });
        if (!response.ok && response.status !== 404) throw new Error(`Artifact delete failed (${response.status})`);
      }));
    },
  };
}
