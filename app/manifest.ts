import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SAGA — Scheduled Automated Generative Authoring",
    short_name: "SAGA",
    description: "Skapa, testa och förädla innehållsflöden som låter som er.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5f0",
    theme_color: "#f7f5f0",
    lang: "sv",
  };
}
