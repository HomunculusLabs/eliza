/** Verifies the trajectory code block a11y attribute contract for empty and non-empty payloads. */
// @vitest-environment jsdom

/**
 * Pins the focus + label contract (axe `aria-prohibited-attr`, Empty story):
 * the affordances attach ONLY when the <pre> has content to read.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TrajectoryCodeBlock } from "./trajectory-code-block";

const baseProps = {
  collapseLabel: "Collapse",
  content: "line one",
  copyLabel: "Copy",
  expandLabel: "Expand",
  label: "Tool input",
  linesLabel: "1 line",
  onCopy: () => {},
};

afterEach(() => cleanup());

describe("TrajectoryCodeBlock aria attribute gating", () => {
  it("attaches tabIndex + aria-label to the pre when content is present", () => {
    const { container } = render(<TrajectoryCodeBlock {...baseProps} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.getAttribute("tabindex")).toBe("0");
    expect(pre?.getAttribute("aria-label")).toBe("Tool input");
  });

  it("omits tabIndex + aria-label on an EMPTY payload (roleless empty pre)", () => {
    const { container } = render(
      <TrajectoryCodeBlock {...baseProps} content="" label="Empty payload" />,
    );
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.getAttribute("tabindex")).toBeNull();
    expect(pre?.getAttribute("aria-label")).toBeNull();
  });
});
