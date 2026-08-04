/**
 * Translates text using the free Google Translate API.
 */
export async function translateMessage(
  text: string,
  srcLang: string,
  dstLang: string
): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
    srcLang
  )}&tl=${encodeURIComponent(dstLang)}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Translate request failed: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (data && data[0] && Array.isArray(data[0])) {
    const translatedParts = data[0]
      .map((part: any) => part[0])
      .filter((txt: any) => typeof txt === "string");
    return translatedParts.join("");
  }

  throw new Error("Invalid response format from Google Translate");
}
