import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientConfigs: [] as Record<string, any>[],
  send: vi.fn(),
  httpHandle: vi.fn(),
  compress: vi.fn(),
  decompress: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }

  return {
    S3Client: class {
      send = mocks.send;

      constructor(config: Record<string, any>) {
        mocks.clientConfigs.push(config);
      }
    },
    PutObjectCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    DeleteObjectCommand: class extends Command {},
  };
});

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class {
    handle = mocks.httpHandle;
  },
}));

vi.mock("@mongodb-js/zstd", () => ({
  compress: mocks.compress,
  decompress: mocks.decompress,
}));

vi.mock("../../lib/logger/logger.js", () => ({
  createServiceLogger: () => mocks.logger,
}));

type LoadOptions = {
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  forcePathStyle?: string;
  /** Use the legacy R2_* variables instead of S3_* to exercise the fallback. */
  legacyR2?: boolean;
};

async function loadStorage(options: LoadOptions = {}) {
  const accessKey = options.accessKey ?? "access-key";
  const secretKey = options.secretKey ?? "secret-key";
  const bucket = options.bucket ?? "test-bucket";

  // Neutralise both variable families first so a value leaked into
  // process.env by another test file (workers are reused) cannot flip the
  // resolver between the S3_* and R2_* branches.
  for (const name of [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_BUCKET_NAME",
    "S3_REGION",
    "S3_FORCE_PATH_STYLE",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
  ]) {
    vi.stubEnv(name, "");
  }

  if (options.legacyR2) {
    vi.stubEnv("R2_ACCOUNT_ID", "account-123");
    vi.stubEnv("R2_ACCESS_KEY_ID", accessKey);
    vi.stubEnv("R2_SECRET_ACCESS_KEY", secretKey);
    vi.stubEnv("R2_BUCKET_NAME", bucket);
  } else {
    vi.stubEnv("S3_ENDPOINT", options.endpoint ?? "https://s3.example.test");
    vi.stubEnv("S3_ACCESS_KEY_ID", accessKey);
    vi.stubEnv("S3_SECRET_ACCESS_KEY", secretKey);
    vi.stubEnv("S3_BUCKET_NAME", bucket);
  }
  if (options.region !== undefined) vi.stubEnv("S3_REGION", options.region);
  if (options.forcePathStyle !== undefined) vi.stubEnv("S3_FORCE_PATH_STYLE", options.forcePathStyle);
  vi.resetModules();

  const { objectStorage } = await import("./s3StorageService.js");
  return objectStorage;
}

function sentInput(call = 0): Record<string, any> {
  return mocks.send.mock.calls[call][0].input;
}

beforeEach(() => {
  mocks.clientConfigs.length = 0;
  mocks.send.mockReset();
  mocks.httpHandle.mockReset();
  mocks.compress.mockReset();
  mocks.decompress.mockReset();
  mocks.logger.debug.mockReset();
  mocks.logger.info.mockReset();
  mocks.compress.mockImplementation(async (input: Buffer) => Buffer.concat([Buffer.from("zstd:"), input]));
  mocks.decompress.mockImplementation(async (input: Buffer) => input.subarray("zstd:".length));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("objectStorage initialization", () => {
  it("stays disabled without credentials and performs no storage I/O", async () => {
    const storage = await loadStorage({ accessKey: "", secretKey: "" });

    expect(storage.isEnabled()).toBe(false);
    await expect(storage.storeBatch(1, "session", [{ type: "pageview" }])).resolves.toBeNull();
    await expect(storage.getBatch("1/session/batch.json.zst")).rejects.toThrow("S3 storage is not enabled");
    await expect(storage.deleteBatch("1/session/batch.json.zst")).resolves.toBeUndefined();
    expect(mocks.clientConfigs).toHaveLength(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { missing: "access key", accessKey: "", secretKey: "secret-key" },
    { missing: "secret key", accessKey: "access-key", secretKey: "" },
    { missing: "both credentials", accessKey: "", secretKey: "" },
  ])("stays disabled when $missing is missing", async ({ accessKey, secretKey }) => {
    const storage = await loadStorage({ accessKey, secretKey });

    expect(storage.isEnabled()).toBe(false);
    expect(mocks.clientConfigs).toHaveLength(0);
  });

  it("configures the S3 endpoint, credentials, path-style requests, and bucket", async () => {
    const storage = await loadStorage({ bucket: "replay-batches", endpoint: "https://minio.internal:9000" });

    expect(storage.isEnabled()).toBe(true);
    expect(mocks.clientConfigs).toHaveLength(1);
    expect(mocks.clientConfigs[0]).toMatchObject({
      region: "auto",
      endpoint: "https://minio.internal:9000",
      credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
      forcePathStyle: true,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { bucket: "replay-batches", endpoint: "https://minio.internal:9000" },
      "S3Storage initialized"
    );
  });

  it("falls back to the legacy R2_* variables and derives the R2 endpoint", async () => {
    const storage = await loadStorage({ legacyR2: true, bucket: "r2-bucket" });

    expect(storage.isEnabled()).toBe(true);
    expect(mocks.clientConfigs[0]).toMatchObject({
      region: "auto",
      endpoint: "https://account-123.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
      forcePathStyle: true,
    });
  });

  it("honours S3_REGION and S3_FORCE_PATH_STYLE=false for virtual-hosted AWS S3", async () => {
    await loadStorage({ region: "eu-west-1", forcePathStyle: "false" });

    expect(mocks.clientConfigs[0]).toMatchObject({ region: "eu-west-1", forcePathStyle: false });
  });

  it("strips checksum response headers without discarding other handler output", async () => {
    mocks.httpHandle.mockResolvedValue({
      response: {
        statusCode: 200,
        headers: {
          etag: "batch-etag",
          "x-amz-checksum-crc32": "checksum",
          "X-Custom-Checksum": "also-a-checksum",
        },
      },
      output: "preserved",
    });
    await loadStorage();

    const handler = mocks.clientConfigs[0].requestHandler;
    const result = await handler.handle({ method: "GET" }, { requestTimeout: 1_000 });

    expect(mocks.httpHandle).toHaveBeenCalledWith({ method: "GET" }, { requestTimeout: 1_000 });
    expect(result).toEqual({
      response: { statusCode: 200, headers: { etag: "batch-etag" } },
      output: "preserved",
    });
  });
});

describe("objectStorage.storeBatch", () => {
  it("compresses JSON and stores it with a deterministic key and retrieval metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_725_000_123_456);
    mocks.send.mockResolvedValue({});
    const storage = await loadStorage();
    const events = [
      { type: "pageview", path: "/" },
      { type: "custom_event", name: "signup" },
    ];

    await expect(storage.storeBatch(42, "session/with spaces", events)).resolves.toBe(
      "42/session/with spaces/1725000123456.json.zst"
    );

    expect(mocks.compress).toHaveBeenCalledOnce();
    expect(mocks.compress.mock.calls[0][0].toString()).toBe(JSON.stringify(events));
    expect(mocks.compress.mock.calls[0][1]).toBe(3);
    expect(sentInput()).toMatchObject({
      Bucket: "test-bucket",
      Key: "42/session/with spaces/1725000123456.json.zst",
      ContentType: "application/octet-stream",
      Metadata: {
        siteId: "42",
        sessionId: "session/with spaces",
        eventCount: "2",
        compression: "zstd",
      },
    });
    expect(sentInput().Body).toEqual(Buffer.from(`zstd:${JSON.stringify(events)}`));
  });

  it("supports empty batches and records a zero event count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    mocks.send.mockResolvedValue({});
    const storage = await loadStorage();

    await expect(storage.storeBatch(0, "empty", [])).resolves.toBe("0/empty/100.json.zst");
    expect(sentInput().Metadata.eventCount).toBe("0");
  });

  it("propagates compression failures without issuing a put", async () => {
    const compressionError = new Error("zstd worker failed");
    mocks.compress.mockRejectedValue(compressionError);
    const storage = await loadStorage();

    await expect(storage.storeBatch(1, "session", [{}])).rejects.toBe(compressionError);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[S3Storage] Failed to store batch:", compressionError);
  });

  it("propagates object-store failures after compression", async () => {
    const putError = new Error("object store unavailable");
    mocks.send.mockRejectedValue(putError);
    const storage = await loadStorage();

    await expect(storage.storeBatch(1, "session", [{}])).rejects.toBe(putError);
    expect(mocks.compress).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("[S3Storage] Failed to store batch:", putError);
  });

  it("allows independent stores to progress concurrently", async () => {
    vi.spyOn(Date, "now").mockReturnValue(500);
    let releaseFirst!: (value: Buffer) => void;
    const firstCompression = new Promise<Buffer>(resolve => {
      releaseFirst = resolve;
    });
    mocks.compress.mockImplementationOnce(() => firstCompression).mockResolvedValueOnce(Buffer.from("second"));
    mocks.send.mockResolvedValue({});
    const storage = await loadStorage();

    const first = storage.storeBatch(1, "first", [{ sequence: 1 }]);
    const second = storage.storeBatch(2, "second", [{ sequence: 2 }]);

    await expect(second).resolves.toBe("2/second/500.json.zst");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(sentInput().Key).toBe("2/second/500.json.zst");

    releaseFirst(Buffer.from("first"));
    await expect(first).resolves.toBe("1/first/500.json.zst");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});

describe("objectStorage.getBatch", () => {
  it("reads already-decompressed JSON streams without invoking a codec", async () => {
    mocks.send.mockResolvedValue({ Body: Readable.from([Buffer.from("  ["), Buffer.from('{"type":"pageview"}]')]) });
    const storage = await loadStorage();

    await expect(storage.getBatch("1/session/batch.json.zst")).resolves.toEqual([{ type: "pageview" }]);
    expect(sentInput()).toEqual({ Bucket: "test-bucket", Key: "1/session/batch.json.zst" });
    expect(mocks.decompress).not.toHaveBeenCalled();
  });

  it("decompresses zstd objects assembled from multiple stream chunks", async () => {
    const compressed = Buffer.from('zstd:[{"type":"identify"}]');
    mocks.send.mockResolvedValue({ Body: Readable.from([compressed.subarray(0, 7), compressed.subarray(7)]) });
    const storage = await loadStorage();

    await expect(storage.getBatch("1/session/batch.json.zst")).resolves.toEqual([{ type: "identify" }]);
    expect(mocks.decompress).toHaveBeenCalledWith(compressed);
  });

  it("uses gzip decompression for legacy .gz objects", async () => {
    const events = [{ type: "pageview", pathname: "/legacy" }];
    mocks.send.mockResolvedValue({ Body: Readable.from([gzipSync(JSON.stringify(events))]) });
    const storage = await loadStorage();

    await expect(storage.getBatch("1/session/legacy.json.gz")).resolves.toEqual(events);
    expect(mocks.decompress).not.toHaveBeenCalled();
  });

  it("defaults unknown extensions to zstd decompression", async () => {
    const compressed = Buffer.from('zstd:[{"type":"custom_event"}]');
    mocks.send.mockResolvedValue({ Body: Readable.from([compressed]) });
    const storage = await loadStorage();

    await expect(storage.getBatch("1/session/batch.bin")).resolves.toEqual([{ type: "custom_event" }]);
    expect(mocks.decompress).toHaveBeenCalledWith(compressed);
  });

  it("falls through from JSON-looking but invalid bytes to decompression", async () => {
    const bytes = Buffer.from("[compressed-zstd-payload");
    mocks.send.mockResolvedValue({ Body: Readable.from([bytes]) });
    mocks.decompress.mockResolvedValue(Buffer.from('[{"recovered":true}]'));
    const storage = await loadStorage();

    await expect(storage.getBatch("1/session/batch.json.zst")).resolves.toEqual([{ recovered: true }]);
    expect(mocks.decompress).toHaveBeenCalledWith(bytes);
  });

  it("rejects empty responses and preserves the retrieval context in the log", async () => {
    mocks.send.mockResolvedValue({});
    const storage = await loadStorage();

    await expect(storage.getBatch("missing.json.zst")).rejects.toThrow("Empty response body");
    expect(console.error).toHaveBeenCalledWith(
      "[S3Storage] Failed to retrieve batch:",
      expect.objectContaining({ message: "Empty response body" })
    );
  });

  it("rethrows the codec error for irrecoverably corrupted objects", async () => {
    const codecError = new Error("invalid zstd frame");
    mocks.send.mockResolvedValue({ Body: Readable.from([Buffer.from("not-json-or-zstd")]) });
    mocks.decompress.mockRejectedValue(codecError);
    const storage = await loadStorage();

    await expect(storage.getBatch("corrupt.json.zst")).rejects.toBe(codecError);
    expect(console.error).toHaveBeenCalledWith("[S3Storage] Failed to retrieve batch:", codecError);
  });

  it("propagates object-store read failures", async () => {
    const getError = new Error("read denied");
    mocks.send.mockRejectedValue(getError);
    const storage = await loadStorage();

    await expect(storage.getBatch("private.json.zst")).rejects.toBe(getError);
  });
});

describe("objectStorage.deleteBatch", () => {
  it("deletes an enabled object's exact key", async () => {
    mocks.send.mockResolvedValue({});
    const storage = await loadStorage();

    await expect(storage.deleteBatch("1/session/batch.json.zst")).resolves.toBeUndefined();
    expect(sentInput()).toEqual({ Bucket: "test-bucket", Key: "1/session/batch.json.zst" });
  });

  it("logs and suppresses cleanup failures", async () => {
    const deleteError = new Error("temporary delete failure");
    mocks.send.mockRejectedValue(deleteError);
    const storage = await loadStorage();

    await expect(storage.deleteBatch("1/session/batch.json.zst")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("[S3Storage] Failed to delete batch:", deleteError);
  });
});
