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

export default defineConfig({
  content: docs.toFumadocsSource(),
  site: {
    name: "Tegami",
  },
})
  .layouts({
    defaultProps: () => ({
      nav: {
        title: (
          <>
            <Image src="/logo.png" width={64} height={64} className="size-8 rounded-sm" />
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
        };
      },
    }),
  );
