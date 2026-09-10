/** View chrome stays absent while real page actions remain usable; opt-in
 * titled navigation keeps trapped compact surfaces navigable (#30980). */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewHeader } from "./ViewHeader";

afterEach(cleanup);
describe("ViewHeader", () => {
  it("does not render a title, back button, or empty row", () => {
    const { container } = render(
      <ViewHeader title="Knowledge" onBack={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
  });
  it("preserves page actions without restoring title or navigation chrome", () => {
    const add = vi.fn();
    render(
      <ViewHeader
        title="Notes"
        right={
          <button type="button" onClick={add}>
            Add note
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(add).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });
  it("renders the titled navigation bar with a working back control when showBack is set", () => {
    // Compact surfaces with no sidebar affordance (Settings section → hub)
    // opt into the navigation bar; without it they trap the user (#30980).
    const onBack = vi.fn();
    render(
      <ViewHeader
        title="Runtime"
        showBack
        onBack={onBack}
        backLabel="Back to Settings"
      />,
    );
    const header = screen.getByTestId("view-header");
    expect(header.tagName).toBe("HEADER");
    expect(screen.getByRole("heading", { name: "Runtime" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("keeps trailing actions usable alongside the titled navigation bar", () => {
    const add = vi.fn();
    render(
      <ViewHeader
        title="Notes"
        showBack
        onBack={vi.fn()}
        right={
          <button type="button" onClick={add}>
            Add note
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(add).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
  });
});
