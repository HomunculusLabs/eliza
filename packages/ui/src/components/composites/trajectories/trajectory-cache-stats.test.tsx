/**
 * Verifies the trajectory cache stats definition-list content model required
 * by the story gate: every div group inside <dl> contains only dt/dd
 * children, with meta rendered as a second <dd> for its <dt>
 * (axe `definition-list`, Default + SingleMetric failures).
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TrajectoryCacheStats } from "./trajectory-cache-stats";

afterEach(() => cleanup());

function metricsWithMeta() {
  return [
    {
      id: "hits",
      label: "Cache hits",
      value: "1,284",
      meta: "+12% vs last run",
    },
    {
      id: "ratio",
      label: "Hit ratio",
      value: "93.0%",
    },
  ];
}

describe("TrajectoryCacheStats definition-list structure", () => {
  it("keeps every dl div group to dt/dd children only (meta nested inside dd)", () => {
    const { container } = render(
      <TrajectoryCacheStats
        heading="Cache observations"
        metrics={metricsWithMeta()}
      />,
    );
    const dl = container.querySelector("dl");
    expect(dl).not.toBeNull();
    const groups = Array.from(dl?.querySelectorAll(":scope > div") ?? []);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const child of Array.from(group.children)) {
        expect(["DT", "DD"]).toContain(child.tagName);
      }
    }
    // The meta line renders as a second dd for its dt, never a div sibling.
    const meta = screen.getByText("+12% vs last run");
    expect(meta.tagName).toBe("DD");
    // The second dd still belongs to the metric's dt (immediately after it
    // in the same dl group), not to a loose div wrapper.
    expect(meta.previousElementSibling?.tagName).toBe("DD");
    expect(meta.parentElement?.querySelector("dt")).not.toBeNull();
  });
});
