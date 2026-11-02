// Draws the Neural app icon (build/icon.png, 1024×1024): the brand gradient in
// a macOS-style rounded square with a small network of connected nodes.
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/icon.png"
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// macOS icon grid: an 824px rounded square centred in 1024.
let inset: CGFloat = 100
let rect = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = CGPath(roundedRect: rect, cornerWidth: 186, cornerHeight: 186, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.28).cgColor)
ctx.addPath(shape)
ctx.setFillColor(NSColor.black.cgColor)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let colors = [
  NSColor(srgbRed: 0.18, green: 0.36, blue: 0.83, alpha: 1).cgColor,  // blue
  NSColor(srgbRed: 0.54, green: 0.36, blue: 0.96, alpha: 1).cgColor,  // violet
  NSColor(srgbRed: 0.19, green: 0.65, blue: 0.63, alpha: 1).cgColor,  // teal
] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: rect.minX, y: rect.maxY), end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
// Soft light from the top.
let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [NSColor.white.withAlphaComponent(0.22).cgColor, NSColor.white.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: size / 2, y: rect.maxY), startRadius: 0, endCenter: CGPoint(x: size / 2, y: rect.maxY), endRadius: 620, options: [])

// A small network: one central node joined to six around it, and a ring between them.
let c = CGPoint(x: size / 2, y: size / 2)
let r: CGFloat = 235
let outer = (0..<6).map { i -> CGPoint in
  let a = CGFloat(i) * .pi / 3 + .pi / 6
  return CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a))
}
ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.55).cgColor)
ctx.setLineWidth(18)
ctx.setLineCap(.round)
for (i, p) in outer.enumerated() {
  ctx.move(to: c); ctx.addLine(to: p)
  ctx.move(to: p); ctx.addLine(to: outer[(i + 1) % 6])
}
ctx.strokePath()
ctx.setFillColor(NSColor.white.cgColor)
for p in outer { ctx.fillEllipse(in: CGRect(x: p.x - 44, y: p.y - 44, width: 88, height: 88)) }
ctx.fillEllipse(in: CGRect(x: c.x - 78, y: c.y - 78, width: 156, height: 156))
ctx.restoreGState()

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("icon: \(out)")
