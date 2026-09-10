#!/usr/bin/env swift
import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fputs("Usage: render-dmg-background.swift <source.png> <output.png>\n", stderr)
    exit(1)
}

let sourceURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
guard let source = NSImage(contentsOf: sourceURL) else {
    fputs("Unable to read source image\n", stderr)
    exit(1)
}
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: 1280,
    pixelsHigh: 840,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("Unable to create output bitmap\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
source.draw(
    in: NSRect(x: 0, y: 0, width: 1280, height: 840),
    from: NSRect(x: 0, y: 4, width: 1280, height: 840),
    operation: .copy,
    fraction: 1
)

let centered = NSMutableParagraphStyle()
centered.alignment = .center

let title = "INSTALL MELDWORK" as NSString
title.draw(
    in: NSRect(x: 0, y: 712, width: 1280, height: 52),
    withAttributes: [
        .font: NSFont(name: "DIN Alternate Bold", size: 38) ?? NSFont.boldSystemFont(ofSize: 38),
        .foregroundColor: NSColor(white: 0.96, alpha: 0.94),
        .kern: 4.5,
        .paragraphStyle: centered,
    ]
)

let explanation = "DRAG MELDWORK INTO APPLICATIONS  /  YOUR WORKSPACE STAYS LOCAL" as NSString
explanation.draw(
    in: NSRect(x: 0, y: 675, width: 1280, height: 30),
    withAttributes: [
        .font: NSFont(name: "Menlo-Regular", size: 14) ?? NSFont.monospacedSystemFont(ofSize: 14, weight: .regular),
        .foregroundColor: NSColor(white: 0.82, alpha: 0.74),
        .kern: 1.5,
        .paragraphStyle: centered,
    ]
)
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Unable to encode PNG\n", stderr)
    exit(1)
}
try png.write(to: outputURL)
