// Tailwind v4: configuration lives in CSS (globals.css via @import "tailwindcss").
// Color tokens are read directly from CSS custom properties — no JS config needed.
// Content scanning is auto-detected in v4; explicit paths kept for safety.
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
};
export default config;
