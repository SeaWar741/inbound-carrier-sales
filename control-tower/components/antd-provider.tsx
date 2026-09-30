"use client";

import { ConfigProvider, type ThemeConfig } from "antd";

// Ant Design in the tower's light palette. antd derives hover and focus shades from these, so they
// are hex copies of the oklch tokens in globals.css (accent, fg ramp, lines).
const theme: ThemeConfig = {
  token: {
    colorPrimary: "#0285ff",
    colorText: "#1f2124",
    colorTextSecondary: "#62656b",
    colorTextPlaceholder: "#9a9da3",
    colorTextQuaternary: "#9a9da3",
    colorBorder: "#e0e2e5",
    colorBorderSecondary: "#ecedef",
    colorBgContainer: "#ffffff",
    colorFillTertiary: "#f4f5f6",
    controlItemBgActive: "#e9f3ff",
    controlItemBgHover: "#f4f5f6",
    fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
    fontSize: 13,
    fontSizeSM: 12,
    borderRadius: 8,
    borderRadiusSM: 8,
    borderRadiusLG: 8,
    controlHeight: 40,
    controlHeightSM: 36,
  },
  components: {
    Select: { optionSelectedBg: "#e9f3ff", optionSelectedColor: "#0285ff", optionFontSize: 12 },
    // The sort arrow already says which column sorts; no gray band on it.
    Table: { headerBg: "#fafafa", headerSortActiveBg: "#fafafa", headerSortHoverBg: "#fafafa", bodySortBg: "transparent" },
  },
};

export function AntdProvider({ children }: { children: React.ReactNode }) {
  return <ConfigProvider theme={theme}>{children}</ConfigProvider>;
}
