// OCR-on-image — runs the SAME Apple Vision OCR config as screen.swift on a saved image file, so the
// capture-quality eval measures exactly what ships. Config is env-overridable to A/B improvements:
//   CONTINUUM_OCR_MINCONF (0.4) · CONTINUUM_OCR_MINHEIGHT (0) · CONTINUUM_OCR_LANGCORRECT (1)
//   CONTINUUM_OCR_LEVEL (accurate|fast) · CONTINUUM_OCR_MINWORDS (2) · CONTINUUM_OCR_LANGS (e.g. en-US,fr-FR)
// Build: swiftc daemon/stage1/ocr-image.swift -o daemon/stage1/ocr-image
// Run:   ./daemon/stage1/ocr-image <image-path>   → OCR text on stdout
import Foundation
import Vision
import CoreGraphics
import AppKit

let env = ProcessInfo.processInfo.environment
func envF(_ k: String, _ d: Float) -> Float { Float(env[k] ?? "") ?? d }

func looksLikeGlyphSoup(_ s: String) -> Bool {
  let scalars = Array(s.unicodeScalars.filter { $0 != " " })
  if scalars.isEmpty { return true }
  let alnum = scalars.filter { CharacterSet.alphanumerics.contains($0) }.count
  return Double(alnum) / Double(scalars.count) < 0.5
}

struct Box { let rect: CGRect; let text: String }

// Recursive XY-cut reading order: split the page on the most significant whitespace gutter — a vertical
// gutter separates COLUMNS (read left→right), a horizontal gap separates BLOCKS (read top→bottom) —
// recurse, and concatenate. Falls back to a top-left sort when no clean cut remains. This fixes the
// dominant failure of the naive (row,x) band-sort: interleaving sidebars/columns/overlays line-by-line.
// Vision boundingBox is normalized [0,1] with y BOTTOM-UP (so "higher on screen" = larger y).
func readingOrder(_ boxes: [Box], _ depth: Int = 0) -> [Box] {
  func topLeft(_ bs: [Box]) -> [Box] {
    bs.sorted { a, b in abs(a.rect.midY - b.rect.midY) > 0.012 ? a.rect.midY > b.rect.midY : a.rect.minX < b.rect.minX }
  }
  if boxes.count <= 1 || depth > 24 { return topLeft(boxes) }
  let colGap = envF("CONTINUUM_OCR_COLGAP", 0.035), rowGap = envF("CONTINUUM_OCR_ROWGAP", 0.022)
  // widest empty gutter along an axis: sort the [lo,hi] intervals, find the largest gap no box spans.
  func widestGap(_ lo: (Box) -> CGFloat, _ hi: (Box) -> CGFloat) -> (pos: CGFloat, size: CGFloat) {
    let iv = boxes.map { (lo($0), hi($0)) }.sorted { $0.0 < $1.0 }
    var maxEnd = iv[0].1, gp: CGFloat = 0, gs: CGFloat = -1
    for k in 1..<iv.count { let g = iv[k].0 - maxEnd; if g > gs { gs = g; gp = maxEnd + g / 2 }; maxEnd = max(maxEnd, iv[k].1) }
    return (gp, gs)
  }
  let v = widestGap({ $0.rect.minX }, { $0.rect.maxX })   // vertical gutter → columns
  let h = widestGap({ $0.rect.minY }, { $0.rect.maxY })   // horizontal gap → blocks
  let vSig = v.size / CGFloat(colGap), hSig = h.size / CGFloat(rowGap)       // significance relative to each threshold
  if vSig >= 1 && vSig >= hSig {
    let l = boxes.filter { $0.rect.midX < v.pos }, r = boxes.filter { $0.rect.midX >= v.pos }
    if !l.isEmpty && !r.isEmpty { return readingOrder(l, depth + 1) + readingOrder(r, depth + 1) }   // left col, then right
  }
  if hSig >= 1 {
    let top = boxes.filter { $0.rect.midY >= h.pos }, bot = boxes.filter { $0.rect.midY < h.pos }
    if !top.isEmpty && !bot.isEmpty { return readingOrder(top, depth + 1) + readingOrder(bot, depth + 1) }   // top block, then bottom
  }
  return topLeft(boxes)
}

func ocr(_ image: CGImage) -> String {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = (env["CONTINUUM_OCR_LEVEL"] == "fast") ? .fast : .accurate
  req.usesLanguageCorrection = (env["CONTINUUM_OCR_LANGCORRECT"] ?? "1") != "0"
  req.minimumTextHeight = envF("CONTINUUM_OCR_MINHEIGHT", 0)
  if let langs = env["CONTINUUM_OCR_LANGS"], !langs.isEmpty { req.recognitionLanguages = langs.split(separator: ",").map { String($0) } }
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
  let minConf = envF("CONTINUUM_OCR_MINCONF", 0.4)
  // Keep any substantial line (>= minChars, default 3) that isn't symbol-soup. The old "needs >=2 words
  // OR >=16 chars" rule dropped short SINGLE-word facts (names/numbers/labels like "WORLD","3.2K") —
  // measured at fact-recall 0.80 vs 0.97 once relaxed. We only drop <=2-char junk ("X","v") + glyph soup.
  let minChars = Int(envF("CONTINUUM_OCR_MINCHARS", 3))
  var boxes: [Box] = []
  var seen = Set<String>()
  for obs in (req.results ?? []) {
    guard let cand = obs.topCandidates(1).first, cand.confidence >= minConf else { continue }   // drop low-confidence misreads
    let t = cand.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.count >= minChars, t.count <= 5000, !looksLikeGlyphSoup(t), !seen.contains(t) {
      seen.insert(t); boxes.append(Box(rect: obs.boundingBox, text: t))
    }
  }
  let ordered = (env["CONTINUUM_OCR_ORDER"] == "naive")
    ? boxes.sorted { a, b in let ra = Int((1 - a.rect.midY) * 60), rb = Int((1 - b.rect.midY) * 60); return ra != rb ? ra < rb : a.rect.minX < b.rect.minX }
    : readingOrder(boxes)
  return ordered.map { $0.text }.joined(separator: "\n")
}

guard CommandLine.arguments.count > 1 else { FileHandle.standardError.write("usage: ocr-image <image-path>\n".data(using: .utf8)!); exit(2) }
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("ocr-image: cannot load \(path)\n".data(using: .utf8)!); exit(1)
}
print(ocr(cg))
