import { Marquee } from "./marquee";

interface APISponsorItem {
  __typename: "User" | "Organization";
  login: string;
  avatarUrl: string;
  websiteUrl: string | null;
  name: string;
  tier: {
    monthlyPriceInDollars: number;
    name?: string;
  };
  tierName?: string;
  isActive: boolean;
  isOneTimePayment: boolean;
}

const visibleTiers = ["Golden Sponsor", "Platinum Sponsor"];

export async function SponsorsMarquee() {
  const sponsors = await getSponsors();
  const items = sponsors.filter(
    (item) =>
      item.isActive &&
      item.tierName &&
      item.__typename === "Organization" &&
      visibleTiers.includes(item.tierName),
  );
  if (items.length === 0) return null;

  return (
    <div className="bg-fd-card border rounded-md px-2 py-1.5 max-w-full">
      <a
        href="https://fuma-nama.dev/sponsors"
        className="inline-flex items-center gap-1 text-xs font-medium text-fd-muted-foreground hover:text-fd-accent-foreground"
      >
        Sponsors
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5"
        >
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </a>
      <Marquee
        pauseOnHover
        className="px-0 [mask-image:linear-gradient(to_right,transparent,white_10%,white_90%,transparent)]"
      >
        {items.map((item) => (
          <a
            key={item.login}
            href={getSponsorUrl(item)}
            rel="sponsored noreferrer noopener"
            target="_blank"
            className="flex items-center gap-1.5 text-xs whitespace-nowrap text-fd-muted-foreground hover:text-fd-accent-foreground"
          >
            <img
              src={item.avatarUrl}
              alt={item.name}
              width={20}
              height={20}
              loading="lazy"
              className="size-5 rounded-full"
            />
            {item.name}
          </a>
        ))}
      </Marquee>
    </div>
  );
}

async function getSponsors(): Promise<APISponsorItem[]> {
  try {
    const res = await fetch("https://fuma-nama.dev/api/sponsors");
    if (!res.ok) return [];
    return (await res.json()) as APISponsorItem[];
  } catch {
    return [];
  }
}

function getSponsorUrl(item: APISponsorItem): string {
  if (!item.websiteUrl) return `https://github.com/${item.login}`;
  if (!/^https?:\/\//.test(item.websiteUrl)) return `https://${item.websiteUrl}`;
  return item.websiteUrl;
}
