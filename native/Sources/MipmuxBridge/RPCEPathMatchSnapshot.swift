import Foundation

extension PathMatchSnapshot {
    func file(_ full: String) -> FileRecord? {
        fileRecord(forFullPath: full)
    }

    func folder(_ full: String) -> FolderRecord? {
        folderRecord(forFullPath: full)
    }
}
