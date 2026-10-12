// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: captured DTOs, executable-local owner and existing native file-block formatter.
// Preserve original source function boundaries and argument labels.
// swiftlint:disable line_length
import Foundation

struct MetaInstruction {
    let title: String
    let content: String
}

// swiftlint:disable:next type_body_length
enum RPCEClipboardPackaging {
    // Returns the opening ``` fence, suffixed with the file extension (\"swift\", \"js\", …).

    // NEW: Helpers for title snippet
    private static func isGenericTabTitle(_ title: String) -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.range(of: #"^T\d+$"#, options: .regularExpression) != nil
    }

    private static func escapeXML(_ text: String) -> String {
        var escaped = text.replacingOccurrences(of: "&", with: "&amp;")
        escaped = escaped.replacingOccurrences(of: "<", with: "&lt;")
        escaped = escaped.replacingOccurrences(of: ">", with: "&gt;")
        escaped = escaped.replacingOccurrences(of: "\"", with: "&quot;")
        escaped = escaped.replacingOccurrences(of: "'", with: "&apos;")
        return escaped
    }

    private static func titleSnippet(for tabTitle: String?) -> String? {
        guard let raw = tabTitle?.trimmingCharacters(in: .whitespacesAndNewlines), raw.isEmpty == false else {
            return nil
        }
        guard isGenericTabTitle(raw) == false else { return nil }
        let escaped = escapeXML(raw)
        return """
        <title>
        \(escaped)
        </title>

        """
    }

    /// Produce file contents as an array of strings, each with the file path + raw content
    static func partitionPromptEntriesForGitDiff(
        _ entries: [ResolvedPromptFileEntry]
    ) -> (diffEntries: [ResolvedPromptFileEntry], codeEntries: [ResolvedPromptFileEntry]) {
        guard !entries.isEmpty else { return ([], []) }
        var diffEntries: [ResolvedPromptFileEntry] = []
        var codeEntries: [ResolvedPromptFileEntry] = []
        diffEntries.reserveCapacity(entries.count)
        codeEntries.reserveCapacity(entries.count)

        for entry in entries {
            if entry.role == .authorizedGitDiffArtifact {
                diffEntries.append(entry)
            } else {
                codeEntries.append(entry)
            }
        }
        return (diffEntries, codeEntries)
    }

    static func selectedGitDiffText(
        fromDiffEntries diffEntries: [ResolvedPromptFileEntry]
    ) -> String? {
        let rawParts = generateRawFileTexts(diffEntries)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return rawParts.isEmpty ? nil : rawParts.joined(separator: "\n\n")
    }

    static func selectedGitDiffText(
        from entries: [ResolvedPromptFileEntry]
    ) -> String? {
        let (diffEntries, _) = partitionPromptEntriesForGitDiff(entries)
        return selectedGitDiffText(fromDiffEntries: diffEntries)
    }

    static func resolveGitDiff(
        fromDiffEntries diffEntries: [ResolvedPromptFileEntry],
        fallback: @Sendable () async -> String?
    ) async -> String? {
        if let selected = selectedGitDiffText(fromDiffEntries: diffEntries) {
            return selected
        }
        return await fallback()
    }

    static func resolveGitDiff(
        from entries: [ResolvedPromptFileEntry],
        fallback: @Sendable () async -> String?
    ) async -> String? {
        if let selected = selectedGitDiffText(from: entries) {
            return selected
        }
        return await fallback()
    }

    static func generateRawFileTexts(
        _ entries: [ResolvedPromptFileEntry]
    ) -> [String] {
        guard !entries.isEmpty else { return [] }
        var blocks: [String] = []
        blocks.reserveCapacity(entries.count)

        for entry in entries {
            guard let content = entry.loadedContent, !content.isEmpty else { continue }
            if let ranges = entry.lineRanges, !ranges.isEmpty {
                let assembly = SliceAssemblyBuilder.build(from: content, ranges: ranges)
                if assembly.isFullFile {
                    blocks.append(assembly.combinedText)
                } else {
                    let text = assembly.segments.map(\.text).joined(separator: "\n")
                    if !text.isEmpty {
                        blocks.append(text)
                    }
                }
            } else {
                blocks.append(content)
            }
        }

        return blocks
    }

    static func generateFileContents(
        _ files: [ResolvedPromptFileEntry],
        filePathDisplay: FilePathDisplay = .full,
        codemapPresentation: WorkspaceCodemapOperationPresentation,
        displayPathResolver: ((ResolvedPromptFileEntry) -> String?)? = nil
    ) -> [String] {
        let (_, contentBlocks) = generatePartitionedFileBlocks(files, filePathDisplay: filePathDisplay, codemapPresentation: codemapPresentation, displayPathResolver: displayPathResolver)
        return contentBlocks
    }

    static func combinedFileMapContent(
        fileTreeContent: String?,
        codemapBlocks: [String]
    ) -> String? {
        let codemapContent = codemapBlocks.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let combined = [fileTreeContent ?? "", codemapContent]
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
        return combined.isEmpty ? nil : combined
    }

    static func generatePartitionedFileBlocks(
        _ files: [ResolvedPromptFileEntry],
        filePathDisplay: FilePathDisplay,
        codemapPresentation: WorkspaceCodemapOperationPresentation,
        displayPathResolver: ((ResolvedPromptFileEntry) -> String?)? = nil
    ) -> (codemapBlocks: [String], contentBlocks: [String]) {
        let (_, codeEntries) = partitionPromptEntriesForGitDiff(files)
        let detailed = generateFileBlocksDetailed(files: codeEntries, filePathDisplay: filePathDisplay, codemapPresentation: codemapPresentation, displayPathResolver: displayPathResolver)
        var codemapBlocks: [String] = []
        var contentBlocks: [String] = []

        for record in detailed {
            if record.text.isEmpty { continue }
            if record.isCodemap {
                codemapBlocks.append(record.text)
            } else {
                contentBlocks.append(record.text)
            }
        }

        return (codemapBlocks, contentBlocks)
    }

    static func generateFileBlocksDetailed(
        files: [ResolvedPromptFileEntry],
        filePathDisplay: FilePathDisplay,
        codemapPresentation: WorkspaceCodemapOperationPresentation,
        displayPathResolver: ((ResolvedPromptFileEntry) -> String?)? = nil
    ) -> [ResolvedPromptFileBlockRecord] {
        var blocks: [ResolvedPromptFileBlockRecord] = []
        guard !files.isEmpty else { return blocks }

        let hasMultipleRoots = Set(files.map(\.file.rootID)).count > 1

        for entry in files {
            let file = entry.file
            let selectedPath = displayPathResolver?(entry)
                ?? selectedPath(for: entry, filePathDisplay: filePathDisplay, hasMultipleRoots: hasMultipleRoots)

            if entry.isCodemap {
                if let rendered = codemapPresentation.renderedEntriesByFileID[file.id] {
                    blocks.append(ResolvedPromptFileBlockRecord(entry: entry, file: file, text: rendered.text, isCodemap: true))
                }
                continue
            }

            guard let content = entry.loadedContent else { continue }
            let startFence = RPCEPromptFileBlocks.codeFenceStart(for: file.name)
            let text: String
            if let ranges = entry.lineRanges, !ranges.isEmpty {
                let assembly = SliceAssemblyBuilder.build(from: content, ranges: ranges)
                text = RPCEPromptFileBlocks.renderFileBlock(selectedPath: selectedPath, startFence: startFence, content: content, assembly: assembly).text
            } else {
                text = RPCEPromptFileBlocks.renderFileBlock(selectedPath: selectedPath, startFence: startFence, content: content, assembly: SliceAssemblyBuilder.build(from: content, ranges: nil)).text
            }
            blocks.append(ResolvedPromptFileBlockRecord(entry: entry, file: file, text: text, isCodemap: false))
        }

        return blocks
    }

    // swiftlint:disable:next function_body_length function_parameter_count
    static func generateClipboardContent(
        metaInstructions: [MetaInstruction],
        userInstructions: String,
        files: [ResolvedPromptFileEntry],
        fileTreeContent: String?,
        gitDiff: String? = nil,
        includeSavedPrompts: Bool,
        includeFiles: Bool,
        includeUserPrompt: Bool,
        filePathDisplay: FilePathDisplay,
        codemapPresentation: WorkspaceCodemapOperationPresentation,
        includeDatetimeInUserInstructions: Bool = false,
        promptSectionsOrder: [PromptSection],
        disabledPromptSections: Set<PromptSection>,
        duplicateUserInstructionsAtTop: Bool,
        tabTitle: String? = nil,
        displayPathResolver: ((ResolvedPromptFileEntry) -> String?)? = nil
    ) async -> String {
        var snippets: [PromptSection: String] = [:]

        let (diffEntries, codeEntries) = partitionPromptEntriesForGitDiff(files)
        let (codemapBlocks, contentBlocks) = generatePartitionedFileBlocks(codeEntries, filePathDisplay: filePathDisplay, codemapPresentation: codemapPresentation, displayPathResolver: displayPathResolver)

        if let combinedMap = combinedFileMapContent(
            fileTreeContent: fileTreeContent,
            codemapBlocks: codemapBlocks
        ) {
            snippets[.fileMap] = """
            <file_map>
            \(combinedMap)
            </file_map>

            """
        }

        if includeFiles, !contentBlocks.isEmpty {
            let snippet = """
            <file_contents>
            \(contentBlocks.joined(separator: "\n\n"))
            </file_contents>

            """
            snippets[.fileContents] = snippet
        }

        if includeSavedPrompts, let metaSnippet = buildMetaPromptsSnippet(metaInstructions) {
            snippets[.metaPrompts] = metaSnippet
        }

        let effectiveGitDiff = await resolveGitDiff(
            fromDiffEntries: diffEntries
        ) {
            gitDiff
        }

        if let diff = effectiveGitDiff, !diff.isEmpty {
            let snippet = """
            <git_diff>
            \(diff)
            </git_diff>

            """
            snippets[.gitDiff] = snippet
        }

        if includeUserPrompt, !userInstructions.isEmpty {
            var snippet = ""
            if includeDatetimeInUserInstructions {
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
                let dateString = dateFormatter.string(from: Date())
                snippet += """
                <user_instructions date="\(dateString)">
                \(userInstructions)
                </user_instructions>

                """
            } else {
                snippet += """
                <user_instructions>
                \(userInstructions)
                </user_instructions>

                """
            }
            snippets[.userInstructions] = snippet
        }

        let clipboardContent = PromptAssemblyBuilder.build(
            order: promptSectionsOrder,
            disabled: disabledPromptSections,
            duplicateUserInstructionsAtTop: duplicateUserInstructionsAtTop,
            snippets: snippets
        )

        let prefix = Self.titleSnippet(for: tabTitle) ?? ""
        return prefix + clipboardContent
    }

    private static func selectedPath(
        for entry: ResolvedPromptFileEntry,
        filePathDisplay: FilePathDisplay,
        hasMultipleRoots: Bool
    ) -> String {
        if filePathDisplay == .relative {
            if hasMultipleRoots,
               let rootFolderPath = entry.rootFolderPath,
               !rootFolderPath.isEmpty {
                let rootFolderName = (StandardizedPath.absolute(rootFolderPath) as NSString).lastPathComponent
                return rootFolderName.isEmpty ? entry.file.relativePath : "\(rootFolderName)/\(entry.file.relativePath)"
            }
            return entry.file.relativePath
        }
        return entry.file.fullPath
    }

    // MARK: - Shared builder for <meta prompt> blocks

    /// Builds a formatted string containing all meta prompts in XML format
    /// Returns nil if the meta instructions array is empty
    private static func buildMetaPromptsSnippet(_ metas: [MetaInstruction]) -> String? {
        guard !metas.isEmpty else { return nil }
        var snippet = ""
        for (index, meta) in metas.enumerated() {
            snippet += """
            <meta prompt \(index + 1) = "\(meta.title)">
            \(meta.content)
            </meta prompt \(index + 1)>

            """
        }
        return snippet
    }
}
// swiftlint:enable line_length
