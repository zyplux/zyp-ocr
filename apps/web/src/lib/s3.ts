import { S3Client } from '@aws-sdk/client-s3';

export const makeS3Client = (env: Env) =>
  new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    region: env.S3_REGION,
  });

export const sourceKey = (jobId: string) => `jobs/${jobId}/source.pdf`;
export const pageKey = (jobId: string, page: number) => `jobs/${jobId}/pages/${page}.md`;
