import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabGroup } from "./TabGroup";

const tabs = [
  { id: "tools", label: "Tools", component: null, icon: null },
  { id: "models", label: "Models", component: null, icon: null },
];

describe("TabGroup", () => {
  it("two groups on one page never share an element id", () => {
    render(
      <>
        <TabGroup tabs={tabs} activeTab="tools" onTabClick={() => {}} />
        <TabGroup tabs={tabs} activeTab="tools" onTabClick={() => {}} />
      </>,
    );
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the tab-<id> test id of the Settings sidebar", () => {
    render(<TabGroup tabs={tabs} activeTab="tools" onTabClick={() => {}} />);
    expect(screen.getByTestId("tab-tools")).toBeTruthy();
  });
});
