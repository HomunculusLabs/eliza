/**
 * Direct route-boundary tests for the agreement owner surface. The domain
 * service is replaced only to force typed failure/output cases; routing,
 * owner actor selection, and machine-readable HTTP translation are real.
 */

import crypto from "node:crypto";
import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AgreementKnowledgeError } from "../lifeops/household/agreement-knowledge.js";
import { AGREEMENT_UPLOAD_METADATA_BYTES } from "../lifeops/household/agreement-upload-limits.js";
import { handleAgreementKnowledgeRoutes } from "./agreement-knowledge-routes.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function context(input: {
  method: string;
  pathname: string;
  body?: unknown;
  agreements: Record<string, unknown>;
  fileStorage?: { readPrivate: (fileName: string) => Promise<Buffer | null> };
}) {
  const responses: Array<{ data: unknown; status: number }> = [];
  const cache = new Map<string, unknown>();
  const runtime = {
    getService: vi.fn((type: string) =>
      input.fileStorage && type === ServiceType.REMOTE_FILES
        ? input.fileStorage
        : { agreements: input.agreements },
    ),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const ctx = {
    req: {},
    res: {},
    method: input.method,
    pathname: input.pathname,
    url: new URL(`http://localhost${input.pathname}`),
    state: { runtime, adminEntityId: "self" },
    json: (_res: unknown, data: unknown, status = 200) => {
      responses.push({ data, status });
    },
    error: vi.fn(),
    readJsonBody: vi.fn(async () => input.body),
    decodePathComponent: decodeURIComponent,
  } as unknown as LifeOpsRouteContext;
  return { ctx, responses, runtime };
}

describe("agreement knowledge routes", () => {
  it("creates a resumable owner upload without trusting a page count", async () => {
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreement-uploads",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      },
      agreements: {},
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.responses[0]).toMatchObject({
      status: 201,
      data: {
        upload: {
          sizeBytes: 8,
          chunkCount: 1,
          receivedChunkIndexes: [],
          status: "uploading",
        },
      },
    });
  });

  it("does not impose the former 20 MiB document ceiling", async () => {
    const sizeBytes = 20 * 1024 * 1024 + 1;
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreement-uploads",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes,
      },
      agreements: {},
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.ctx.readJsonBody).toHaveBeenCalledWith(
      harness.ctx.req,
      harness.ctx.res,
      { maxBytes: AGREEMENT_UPLOAD_METADATA_BYTES },
    );
    expect(harness.responses[0]?.status).toBe(201);
    expect(harness.responses[0]?.data).toMatchObject({
      upload: { sizeBytes, chunkCount: 6 },
    });
  });

  it("returns a stable forbidden error when the domain denies the read", async () => {
    const readFor = vi.fn(async () => {
      throw new AgreementKnowledgeError(
        "The principal has no active grant",
        "AGREEMENT_ACCESS_DENIED",
        { artifactId: "artifact-1" },
      );
    });
    const harness = context({
      method: "GET",
      pathname: "/api/lifeops/agreements/artifact-1",
      agreements: { readFor },
    });
    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.responses).toEqual([
      {
        status: 403,
        data: {
          error: {
            code: "AGREEMENT_ACCESS_DENIED",
            message: "The principal has no active grant",
            context: { artifactId: "artifact-1" },
          },
        },
      },
    ]);
  });

  it("returns explicit grant effects and exclusions without issuing a grant", async () => {
    const previewGuestRead = vi.fn(async () => ({
      allowed: false,
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: {
        code: "AGREEMENT_ACCESS_DENIED",
        message: "Guest requires a verified identity",
      },
    }));
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreements/grants/preview",
      body: {
        artifactId: "artifact-1",
        principalEntityId: "guest-1",
        householdGrantId: "household-grant-1",
      },
      agreements: { previewGuestRead },
    });
    await handleAgreementKnowledgeRoutes(harness.ctx);
    expect(previewGuestRead).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      ownerEntityId: "self",
    });
    expect(harness.responses[0]).toMatchObject({
      status: 200,
      data: {
        preview: {
          allowed: false,
          exclusions: [
            "read_proposed_or_rejected_obligations",
            "mutate_agreement",
            "inherit_access_from_pin",
          ],
        },
      },
    });
  });

  it("answers a transcription outage at commit with 503, not document blame", async () => {
    const createAgreementVersion = vi.fn(async () => {
      throw new AgreementKnowledgeError(
        "Agreement page 2 transcription failed: vision provider returned HTTP 503",
        "AGREEMENT_TRANSCRIPTION_UNAVAILABLE",
        { pageNumber: 2 },
        new Error("vision provider returned HTTP 503"),
      );
    });
    const chunkSha = crypto
      .createHash("sha256")
      .update("%PDF-agree")
      .digest("hex");
    const contentIdentity = crypto
      .createHash("sha256")
      .update(
        [
          "agreement-upload-content-v1",
          "10",
          "4194304",
          `0:10:${chunkSha}`,
        ].join("\n"),
        "utf8",
      )
      .digest("hex");
    const manifest = {
      uploadId: "upload-1",
      ownerEntityId: "self",
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      chunkSizeBytes: 4194304,
      chunkCount: 1,
      chunks: [{ index: 0, size: 10, sha256: chunkSha, fileName: "c0.bin" }],
      status: "uploading",
      artifactId: null,
    };
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreement-uploads/upload-1/commit",
      body: { contentIdentity },
      agreements: { createAgreementVersion },
      fileStorage: {
        readPrivate: async () => Buffer.from("%PDF-agree", "utf8"),
      },
    });
    // Seed the resumable-upload manifest the same way beginAgreementUpload +
    // acceptAgreementChunk persist it, so commit reaches artifact creation.
    await (
      harness.runtime as unknown as {
        setCache: (key: string, value: unknown) => Promise<boolean>;
      }
    ).setCache("lifeops:agreement-upload:v1:upload-1", manifest);
    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(createAgreementVersion).toHaveBeenCalledTimes(1);
    expect(harness.responses).toEqual([
      {
        status: 503,
        data: {
          error: {
            code: "AGREEMENT_TRANSCRIPTION_UNAVAILABLE",
            message:
              "Agreement page 2 transcription failed: vision provider returned HTTP 503",
            context: { pageNumber: 2 },
          },
        },
      },
    ]);
  });
});
