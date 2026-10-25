// Prints the document structure Apple Vision finds in an image as JSON.
// Boxes are pixels with a top-left origin: [x, y, w, h].
import Foundation
import Vision

struct Line: Encodable { let text: String; let box: [Double] }
struct Paragraph: Encodable { let text: String; let box: [Double]; let lines: [Line] }
struct List: Encodable { let box: [Double]; let items: [String] }
struct Table: Encodable { let box: [Double]; let rows: [[String]] }
struct Output: Encodable {
  let width: Double; let height: Double
  let paragraphs: [Paragraph]; let lists: [List]; let tables: [Table]
}

@main struct OCR {
  static func main() async {
    guard CommandLine.arguments.count > 1 else {
      FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!)
      exit(2)
    }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    do {
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw CocoaError(.fileReadCorruptFile) }
      let W = Double(img.width), H = Double(img.height)
      func px(_ r: NormalizedRect) -> [Double] {
        let c = r.cgRect
        return [c.minX * W, (1 - c.maxY) * H, c.width * W, c.height * H].map { ($0 * 10).rounded() / 10 }
      }
      let obs = try await RecognizeDocumentsRequest().perform(on: img)
      guard let doc = obs.first?.document else {
        print(String(data: try JSONEncoder().encode(Output(width: W, height: H, paragraphs: [], lists: [], tables: [])), encoding: .utf8)!)
        return
      }
      let paragraphs = doc.paragraphs.map { p in
        Paragraph(text: p.transcript, box: px(p.boundingRegion.boundingBox),
                  lines: p.lines.map { Line(text: $0.transcript, box: px($0.boundingRegion.boundingBox)) })
      }
      let lists = doc.lists.map { l in
        List(box: px(l.boundingRegion.boundingBox), items: l.items.map { $0.content.text.transcript })
      }
      let tables = doc.tables.map { t in
        Table(box: px(t.boundingRegion.boundingBox),
              rows: t.rows.map { row in row.map { $0.content.text.transcript } })
      }
      let out = Output(width: W, height: H, paragraphs: paragraphs, lists: lists, tables: tables)
      print(String(data: try JSONEncoder().encode(out), encoding: .utf8)!)
    } catch {
      FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
