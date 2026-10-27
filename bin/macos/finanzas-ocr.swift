// finanzas-ocr: OCR local con el framework Vision de macOS (el mismo motor que
// "Texto en vivo"). Lee imagenes (JPG, PNG, HEIC, WEBP) y PDF.
//
// Uso:   finanzas-ocr <archivo> [--langs es-ES,en-US]
//        finanzas-ocr --version
// Salida: texto reconocido por stdout, un renglon por linea, de arriba hacia abajo.
// Codigos de salida: 0 ok, 3 no se pudo abrir el archivo, 4 error de Vision, 64 uso.
//
// Compilar: swiftc -O bin/macos/finanzas-ocr.swift -o bin/macos/finanzas-ocr
// (lo hace `npm run setup:mac`). Requiere macOS 11+ y Command Line Tools.

import Foundation
import Vision
import PDFKit
import ImageIO
import CoreGraphics

let version = "finanzas-ocr 1.0"
let maxPdfPages = 5

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

/// Agrupa las observaciones en renglones: mismo alto (midY) = mismo renglon,
/// y dentro del renglon de izquierda a derecha. Asi "TOTAL   $ 45.320,50"
/// queda en una sola linea aunque Vision lo detecte como dos bloques.
func groupLines(_ items: [(CGRect, String)]) -> [String] {
    let sorted = items.sorted { $0.0.midY > $1.0.midY }
    var lines: [[(CGRect, String)]] = []
    for item in sorted {
        if var last = lines.last, let reference = last.first {
            let tolerance = max(reference.0.height, item.0.height) * 0.5
            if abs(reference.0.midY - item.0.midY) <= tolerance {
                last.append(item)
                lines[lines.count - 1] = last
                continue
            }
        }
        lines.append([item])
    }
    return lines.map { line in
        line.sorted { $0.0.minX < $1.0.minX }.map { $0.1 }.joined(separator: "  ")
    }
}

func recognize(_ image: CGImage, languages: [String]) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    let items: [(CGRect, String)] = observations.compactMap { observation -> (CGRect, String)? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return (observation.boundingBox, candidate.string)
    }
    return groupLines(items)
}

/// Carga la imagen respetando la orientacion EXIF (fotos del iPhone).
func loadImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 4096,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
}

/// Dibuja una pagina de PDF escaneado como imagen para pasarla por Vision.
func render(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.5
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard width > 0, height > 0,
          let context = CGContext(
              data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

/// PDF digital: usa su texto. PDF escaneado (sin texto): OCR de la pagina.
func pdfLines(_ url: URL, languages: [String]) throws -> [String] {
    guard let document = PDFDocument(url: url) else { fail("No pude abrir el PDF", code: 3) }
    var lines: [String] = []
    for index in 0..<min(document.pageCount, maxPdfPages) {
        guard let page = document.page(at: index) else { continue }
        let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count >= 20 {
            lines.append(contentsOf: text.components(separatedBy: .newlines))
        } else if let image = render(page) {
            lines.append(contentsOf: try recognize(image, languages: languages))
        }
    }
    return lines
}

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "--version" {
    print(version)
    exit(0)
}
guard arguments.count >= 2 else { fail("Uso: finanzas-ocr <archivo> [--langs es-ES,en-US]", code: 64) }

let url = URL(fileURLWithPath: arguments[1])
var languages = ["es-ES", "en-US"]
if let flag = arguments.firstIndex(of: "--langs"), flag + 1 < arguments.count {
    languages = arguments[flag + 1].split(separator: ",").map { String($0) }
}

do {
    let lines: [String]
    if url.pathExtension.lowercased() == "pdf" {
        lines = try pdfLines(url, languages: languages)
    } else {
        guard let image = loadImage(url) else { fail("No pude abrir la imagen", code: 3) }
        lines = try recognize(image, languages: languages)
    }
    let output = lines
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    print(output)
} catch {
    fail("Error de Vision: \(error.localizedDescription)", code: 4)
}
