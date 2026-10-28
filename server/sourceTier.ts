import type { WebSourceTier } from "../src/types";

/**
 * 来源等级只是域名/路径启发式，不是权威认证。用于在讲解和 UI 中提示用户
 * 该来源相对更接近一手资料，避免把任何网页都称为“已核验”。
 */
export function classifySourceTier(rawUrl: string): WebSourceTier {
  let host = "";
  let pathname = "";
  try {
    const url = new URL(rawUrl);
    host = url.hostname.toLowerCase();
    pathname = url.pathname.toLowerCase();
  } catch {
    return "unknown";
  }
  const officialHosts = [
    "who.int", "europa.eu", "iso.org", "w3.org", "ietf.org", "unicode.org",
    "python.org", "nodejs.org", "react.dev", "typescriptlang.org", "docs.github.com",
  ];
  if (
    host.endsWith(".gov") ||
    host.endsWith(".gov.cn") ||
    host.endsWith(".edu") ||
    host.endsWith(".edu.cn") ||
    host.endsWith(".ac.uk") ||
    host === "gov.cn" ||
    officialHosts.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    host.startsWith("docs.") ||
    host.startsWith("developer.")
  ) {
    return "official";
  }
  const primaryHosts = [
    "arxiv.org", "doi.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov",
    "nature.com", "science.org", "acm.org", "ieee.org", "springer.com",
    "sciencedirect.com", "openreview.net", "usenix.org",
  ];
  if (primaryHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return "primary";
  }
  const secondaryHosts = [
    "wikipedia.org", "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk",
    "nytimes.com", "theguardian.com", "xinhuanet.com", "people.com.cn",
  ];
  if (secondaryHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return "secondary";
  }
  if (/\/(?:official|docs?|reference|manual)\//.test(pathname)) return "primary";
  return "unknown";
}
