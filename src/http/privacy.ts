import privacy from "../../site/privacy.html";
import terms from "../../site/terms.html";

function staticPage(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

/** The public privacy policy and terms, on every host. Google's consent screen links to both. */
export const privacyPage = (): Response => staticPage(privacy);
export const termsPage = (): Response => staticPage(terms);
