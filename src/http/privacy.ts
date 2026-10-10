import { htmlResponse } from "../html";
import privacy from "../../site/privacy.html";
import terms from "../../site/terms.html";

function staticPage(html: string): Response {
  const res = htmlResponse(html);
  res.headers.set("cache-control", "public, max-age=300");
  return res;
}

/** The public privacy policy and terms, on every host. Google's consent screen links to both. */
export const privacyPage = (): Response => staticPage(privacy);
export const termsPage = (): Response => staticPage(terms);
