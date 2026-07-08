import { defineConfig } from "fumapress";
import { fumadocsMdx } from "fumapress/adapters/mdx";
import { flexsearchPlugin } from "fumapress/plugins/flexsearch";
import { llmsPlugin } from "fumapress/plugins/llms.txt";
import { takumiPlugin } from "fumapress/plugins/takumi";
import { docs } from "./.source/server";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { TypeTable } from "fumadocs-ui/components/type-table";
import { Image } from "fumapress/image";
import { imagePlugin } from "fumapress/plugins/image/vercel";
import { Mermaid } from "./src/mermaid";

export default defineConfig({
  content: docs.toFumadocsSource(),
  site: {
    name: "Tegami",
    baseUrl: "https://tegami.fuma-nama.dev",
    git: {
      user: "fuma-nama",
      branch: "dev",
      repo: "tegami",
    },
  },
  meta: {
    root() {
      return (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link
            href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap"
            rel="stylesheet"
          />
        </>
      );
    },
  },
})
  .layouts({
    defaultProps: () => ({
      nav: {
        title: (
          <>
            <Image src="/icon.png" width={64} height={64} className="size-8 rounded-md" />
            Tegami
          </>
        ),
      },
    }),
  })
  .plugins(flexsearchPlugin(), llmsPlugin(), takumiPlugin(), imagePlugin())
  .adapters(
    fumadocsMdx({
      getMdxComponents() {
        return {
          ...defaultMdxComponents,
          TypeTable,
          Mermaid,
        };
      },
    }),
  );
