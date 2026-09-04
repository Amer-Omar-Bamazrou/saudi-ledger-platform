/**
 * L1 — PDF/A-3B post-processing: the spike's stage 2, productionised.
 *
 * The mechanism was PROVEN BY SPIKE (2026-09-02): veraPDF `PASS`,
 * `isCompliant="true"`, 146/146 rules, with Arabic surviving as correctly
 * shaped, extractable text. The two rules the first spike run failed — and
 * this file exists to satisfy — were named by veraPDF, not guessed:
 *
 *   ISO 19005-3 6.2.4.3  DeviceRGB without an RGB OutputIntent → embed an
 *                        sRGB ICC profile as the PDF/A OutputIntent.
 *   ISO 19005-3 6.1.3    missing trailer file identifier → write one;
 *                        pdf-lib does not.
 *
 * 🔴 THE ICC PROFILE IS THE ONE INPUT THE SPIKE COULD NOT SHIP (its PASS used
 * the HP-copyright Windows profile). The shipped file is Debian's
 * `icc-profiles-free` sRGB.icc — a packaged artefact with a PINNED sha256
 * (`icc-profile-pin.test.ts`), the ZATCA-manifest discipline applied to a
 * build input; its licence text sits beside it. Replacing the file without
 * updating the pin is loud, not silent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray } from "pdf-lib";

const ICC_PATH = join(import.meta.dirname, "assets", "sRGB.icc");

export interface PdfA3Options {
  title: string;
  /** The signed ZATCA invoice XML, attached per PDF/A-3 when the document has
   *  one; a non-onboarded company's PDF ships without an attachment and is
   *  still conformant. */
  attachXml?: { fileName: string; content: Buffer; description: string };
}

/** Wrap a Chromium-printed PDF into PDF/A-3B. Returns the finished bytes. */
export async function toPdfA3(chromiumPdf: Buffer | Uint8Array, opts: PdfA3Options): Promise<Uint8Array> {
  const doc = await PDFDocument.load(chromiumPdf);
  doc.setTitle(opts.title, { showInWindowTitleBar: true });
  doc.setProducer("saudi-ledger-platform");
  doc.setCreator("saudi-ledger-platform");
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  if (opts.attachXml) {
    await doc.attach(opts.attachXml.content, opts.attachXml.fileName, {
      mimeType: "text/xml",
      description: opts.attachXml.description,
      // PDF/A-3 requires every embedded file to declare its relationship.
      afRelationship: "Data" as never,
    });
  }

  // XMP: pdfaid part 3, conformance B.
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${opts.title.replace(/[<&]/g, " ")}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>saudi-ledger-platform</xmp:CreatorTool>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const metaStream = doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(metaStream));

  // OutputIntent — ISO 19005-3 6.2.4.3.
  const icc = readFileSync(ICC_PATH);
  const iccStream = doc.context.stream(icc, { N: 3, Length: icc.length });
  const outputIntent = doc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: doc.context.register(iccStream),
  });
  const intents = PDFArray.withContext(doc.context);
  intents.push(doc.context.register(outputIntent));
  doc.catalog.set(PDFName.of("OutputIntents"), intents);

  // Trailer file identifier — ISO 19005-3 6.1.3.
  const id = PDFHexString.of(randomBytes(16).toString("hex").toUpperCase());
  doc.context.trailerInfo.ID = doc.context.obj([id, id]);

  return doc.save();
}
