import { S3Client } from '@aws-sdk/client-s3';

export const makeS3Client = (env: Env): S3Client => new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });

export const sourceKey = (jobId: string): string => `jobs/${jobId}/source.pdf`;
export const pageKey = (jobId: string, page: number): string => `jobs/${jobId}/pages/${page}.md`;
