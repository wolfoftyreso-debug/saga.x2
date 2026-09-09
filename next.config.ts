import type { NextConfig } from "next";

const configuredDevOrigins = process.env.NEXT_DEV_ALLOWED_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// The desktop preview and the in-app browser both use this loopback host.
// It is still local-only; LAN hosts remain an explicit opt-in below.
const allowedDevOrigins = [...new Set(["localhost", "127.0.0.1", ...(configuredDevOrigins ?? [])])];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // In Next 16 the development indicator lives in an on-screen portal. On
  // compact SAGA screens it can sit over the first bottom-navigation target,
  // so keep the local product surface touchable. Compile and runtime errors
  // are still shown by Next.js when this indicator is disabled.
  devIndicators: false,
  // Never expose a broad network origin by default. A local iPhone preview can
  // opt in to its exact LAN address through NEXT_DEV_ALLOWED_ORIGINS.
  allowedDevOrigins,
};

export default nextConfig;
