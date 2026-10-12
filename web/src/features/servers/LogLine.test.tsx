import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LogLine } from "./LogLine.js";

afterEach(cleanup);

describe("LogLine", () => {
  it("keeps markup-looking console text literal", () => {
    const value = "<script>alert(1)</script>";
    const { container } = render(<LogLine line={value} />);

    expect(screen.getByText(value).textContent).toBe(value);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("renders Minecraft colors and formatting as fixed classes", () => {
    const { container } = render(<LogLine line="§cError §lbold§r normal" />);

    expect(container.textContent).toBe("Error bold normal");
    expect(container.querySelector("[class*=\"text-[#ff5555]\"]")).not.toBeNull();
    expect(container.querySelector(".font-bold")).not.toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("renders ANSI basic, extended, and reset SGR codes", () => {
    const { container } = render(<LogLine line={"\u001b[31mred \u001b[1;4mstrong\u001b[0m plain \u001b[38;5;231mbright"} />);
    const spans = [...container.querySelectorAll("span")];

    expect(container.textContent).toBe("red strong plain bright");
    expect(spans.some((span) => span.className.includes("text-[#aa0000]"))).toBe(true);
    expect(spans.some((span) => span.className.includes("font-bold") && span.className.includes("underline"))).toBe(true);
    expect(spans.some((span) => span.className.includes("text-[#ffffff]"))).toBe(true);
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("shows malformed and unsupported escapes instead of hiding them", () => {
    const value = "broken \u001b[31 and \u001b[999m and §z";
    render(<LogLine line={value} />);

    expect(screen.getByText("broken ␛[31 and ␛[999m and §z").textContent).toBe("broken ␛[31 and ␛[999m and §z");
  });

  it("makes control and direction-format characters visible", () => {
    const value = "\u0000\t\n\u007f\u0085\u200b\u202e";
    render(<LogLine line={value} />);

    expect(screen.getByText("␀␉␊␡[U+0085][U+200B][U+202E]").textContent).toBe("␀␉␊␡[U+0085][U+200B][U+202E]");
  });
});
