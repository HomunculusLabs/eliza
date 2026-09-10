/**
 * Real-runtime integration coverage for the owner-reviewed monthly email
 * recipient setup flow (#31015): persistence through the canonical
 * EntityStore, malformed-address and ambiguity rejection, retry idempotency,
 * owner/guest boundary separation, and the no-messaging-identity guarantee.
 * The harness is real (production personal-assistant plugin + production
 * knowledge graph over the real test runtime); assertions read persisted
 * Entity rows directly.
 */

import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { handleFamilyWorkflowRoutes } from "../../routes/family-workflows.js";
import type { LifeOpsRouteContext } from "../../routes/lifeops-routes.js";
import {
  FAMILY_RECIPIENT_ADDRESSES_ATTRIBUTE,
  type FamilyWorkflowRuntimeService,
  getFamilyWorkflowRuntimeService,
} from "./index.js";

const PERSON_ID = "recipient-setup-person-1";
const OTHER_PERSON_ID = "recipient-setup-person-2";

interface ConfirmedAddress {
  address: string;
  confirmedAt: string;
  confirmedBy: string;
}

interface SetupPeople {
  people: Array<{
    entityId: string;
    name: string;
    confirmedAddresses: ConfirmedAddress[];
  }>;
}

describe("monthly email recipient setup (real runtime + EntityStore)", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let service: FamilyWorkflowRuntimeService | null;
  let lastJson: { data: unknown; status: number } | null = null;
  let lastError: { message: string; status: number } | null = null;

  function makeCtx(
    method: string,
    pathname: string,
    body: Record<string, unknown> = {},
  ): LifeOpsRouteContext {
    return {
      req: {} as never,
      res: {} as never,
      method,
      pathname,
      url: new URL(`http://localhost${pathname}`),
      state: { runtime, adminEntityId: "self" },
      json: (_res: unknown, data: unknown, status = 200) => {
        lastJson = { data, status };
      },
      error: (_res: unknown, message: string, status = 400) => {
        lastError = { message, status };
      },
      readJsonBody: async () => body,
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext;
  }

  async function storedRecords(
    entityId: string,
  ): Promise<ConfirmedAddress[] | undefined> {
    const stored = await resolveKnowledgeGraphService(runtime)
      ?.getEntityStore(runtime.agentId)
      .get(entityId);
    const attribute = stored?.attributes?.[
      FAMILY_RECIPIENT_ADDRESSES_ATTRIBUTE
    ] as { value?: unknown } | undefined;
    return Array.isArray(attribute?.value)
      ? (attribute?.value as ConfirmedAddress[])
      : undefined;
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    service = getFamilyWorkflowRuntimeService(runtime);
    if (!service) throw new Error("family workflow runtime unavailable");
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    for (const [entityId, name] of [
      [PERSON_ID, "Alex Co-parent"],
      [OTHER_PERSON_ID, "Sam Guest"],
    ] as const) {
      await entities.upsert({
        entityId,
        type: "person",
        preferredName: name,
        identities: [],
        tags: ["recipient-setup-test"],
        visibility: "owner_only",
        state: {},
      });
    }
  });

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("confirms a delivery address through the owner route and persists it on the Entity", async () => {
    expect(
      await handleFamilyWorkflowRoutes(
        makeCtx(
          "POST",
          "/api/lifeops/family-workflows/recipient-setup/confirm",
          { entityId: PERSON_ID, address: "alex@example.com" },
        ),
      ),
    ).toBe(true);
    expect(lastJson?.status).toBe(201);
    const payload = lastJson?.data as SetupPeople | undefined;
    const people = (payload ?? { people: [] }).people;
    const alex = people.find((person) => person.entityId === PERSON_ID);
    expect(alex?.confirmedAddresses).toEqual([
      expect.objectContaining({ address: "alex@example.com" }),
    ]);
    // Persisted through the canonical EntityStore under the stable identity.
    await expect(storedRecords(PERSON_ID)).resolves.toEqual([
      expect.objectContaining({
        address: "alex@example.com",
        confirmedBy: "self",
      }),
    ]);
  });

  it("rejects malformed addresses and unknown people with structured errors", async () => {
    await handleFamilyWorkflowRoutes(
      makeCtx("POST", "/api/lifeops/family-workflows/recipient-setup/confirm", {
        entityId: PERSON_ID,
        address: "not-an-email",
      }),
    );
    expect(lastError?.status).toBe(400);
    expect(lastError?.message).toMatch(/valid email/i);

    await handleFamilyWorkflowRoutes(
      makeCtx("POST", "/api/lifeops/family-workflows/recipient-setup/confirm", {
        entityId: "missing-person",
        address: "a@example.com",
      }),
    );
    expect(lastError?.status).toBe(400);
    expect(lastError?.message).toMatch(/existing person/i);
  });

  it("retrying the same pair is idempotent and preserves the original confirmation", async () => {
    const address = { entityId: PERSON_ID, address: "retry@example.com" };
    await handleFamilyWorkflowRoutes(
      makeCtx(
        "POST",
        "/api/lifeops/family-workflows/recipient-setup/confirm",
        address,
      ),
    );
    const first = await storedRecords(PERSON_ID);
    await handleFamilyWorkflowRoutes(
      makeCtx(
        "POST",
        "/api/lifeops/family-workflows/recipient-setup/confirm",
        address,
      ),
    );
    const second = await storedRecords(PERSON_ID);
    // Retry dedups only the retried address; earlier confirmations on the
    // same person (from the first test in this file) legitimately persist.
    const retryRecords = second?.filter(
      (record) => record.address === "retry@example.com",
    );
    expect(retryRecords).toHaveLength(1);
    expect(retryRecords?.[0]?.confirmedAt).toBe(
      first?.find((record) => record.address === "retry@example.com")
        ?.confirmedAt,
    );
  });

  it("owner-confirmed addresses are draft-valid without any guest identity existing", async () => {
    await handleFamilyWorkflowRoutes(
      makeCtx("POST", "/api/lifeops/family-workflows/recipient-setup/confirm", {
        entityId: PERSON_ID,
        address: "owner-confirmed@example.com",
      }),
    );
    await expect(
      service?.validateRecipientIdentity({
        recipientEntityId: PERSON_ID,
        recipient: "owner-confirmed@example.com",
        email: { subject: "s", senderGrantId: "g" },
      }),
    ).resolves.toBeUndefined();
    // A different, unconfirmed address for the same person still rejects.
    await expect(
      service?.validateRecipientIdentity({
        recipientEntityId: PERSON_ID,
        recipient: "other@example.com",
        email: { subject: "s", senderGrantId: "g" },
      }),
    ).rejects.toThrow(/not a verified identity/);
  });

  it("recipient setup grants no messaging identity: non-email channels still reject", async () => {
    await handleFamilyWorkflowRoutes(
      makeCtx("POST", "/api/lifeops/family-workflows/recipient-setup/confirm", {
        entityId: PERSON_ID,
        address: "alex@example.com",
      }),
    );
    // Owner confirmation is a delivery address, NOT an authenticated guest
    // messaging identity — the iMessage/Blooio path must still fail closed.
    await expect(
      service?.validateRecipientIdentity({
        recipientEntityId: PERSON_ID,
        recipient: "alex@example.com",
      }),
    ).rejects.toThrow(/not a verified identity/);
  });

  it("emailOptions surfaces confirmed addresses and GET recipient-setup lists them", async () => {
    await handleFamilyWorkflowRoutes(
      makeCtx("POST", "/api/lifeops/family-workflows/recipient-setup/confirm", {
        entityId: OTHER_PERSON_ID,
        address: "sam@example.com",
      }),
    );
    expect(
      await handleFamilyWorkflowRoutes(
        makeCtx("GET", "/api/lifeops/family-workflows/recipient-setup"),
      ),
    ).toBe(true);
    const payload = lastJson?.data as SetupPeople | undefined;
    const people = (payload ?? { people: [] }).people;
    expect(people.length).toBeGreaterThanOrEqual(2);
    const sam = people.find((person) => person.entityId === OTHER_PERSON_ID);
    expect(sam?.confirmedAddresses).toEqual([
      expect.objectContaining({ address: "sam@example.com" }),
    ]);

    const options = await service?.emailOptions();
    expect(options?.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: OTHER_PERSON_ID,
          address: "sam@example.com",
        }),
      ]),
    );
  });
});
