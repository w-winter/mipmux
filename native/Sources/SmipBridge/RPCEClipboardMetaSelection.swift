// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation

// Modified: captured stored prompts and resolved fields replace the app view model.
struct ClipboardMetaSelection {
    let storedPrompts: [CapturedStoredPrompt]
    let metaInstructions: [MetaInstruction]
    func metaInstructions(
        for cfg: PromptContextResolved,
        selectedPromptIDsOverride: [UUID]? = nil
    ) -> [MetaInstruction] {
        // Compose user-selected meta prompts when requested.
        var combinedMeta: [MetaInstruction] = []
        // Add stored prompts: preset's specific prompts OR manually selected for Manual mode
        if let promptIds = cfg.storedPromptIds, !promptIds.isEmpty {
            // Preset has specific stored prompts - use those
            let selectedPrompts = storedPrompts.filter { promptIds.contains($0.id) }
            let metaFromIds = selectedPrompts.map { MetaInstruction(title: $0.title, content: $0.content) }
            combinedMeta.append(contentsOf: metaFromIds)
        } else if cfg.includeMetaPrompts {
            if let overrideIds = selectedPromptIDsOverride {
                let selectedPrompts = storedPrompts.filter { overrideIds.contains($0.id) }
                let metaFromIds = selectedPrompts.map { MetaInstruction(title: $0.title, content: $0.content) }
                combinedMeta.append(contentsOf: metaFromIds)
            } else {
                // Manual mode or preset without specific prompts - use manually selected meta instructions
                combinedMeta.append(contentsOf: metaInstructions)
            }
        }
        // Discover is now a hardcoded system prompt; no need to append dynamic coverage meta here.
        return combinedMeta
    }
}
