#!/bin/bash

# Set the maximum commit size in bytes (1.5GB = 1.5 * 1024 * 1024 * 1024 bytes)
MAX_COMMIT_SIZE=$((1500 * 1024 * 1024))
DATE=$(date +%d%m%Y)
COMMIT_INDEX=1

commit_and_push() {
    local commit_message="updates data directory ${DATE}:V${COMMIT_INDEX}"
    
    # Check if there are staged changes
    if git diff --cached --quiet; then
        echo "No changes to commit for: $commit_message. Skipping..."
        return
    fi
    
    echo "Committing changes."
    git commit -m "$commit_message"
    git push origin HEAD:$(git rev-parse --abbrev-ref HEAD)
    COMMIT_INDEX=$((COMMIT_INDEX + 1))
}

stage_and_commit() {
    local staged_size=0

    while IFS= read -r file; do
        # Check if file exists (it might have been deleted)
        if [[ -e "$file" ]]; then
            # Get file size in bytes
            file_size=$(du -b "$file" | cut -f1)
        else
            file_size=0
        fi

        # Stage the file
        git add -- "$file"
        
        staged_size=$((staged_size + file_size))
        echo "Currently staged size: $staged_size bytes for file: $file"

        if (( staged_size > MAX_COMMIT_SIZE )); then
            echo "Staged changes exceed 1.5GB. Committing and resetting."
            commit_and_push
            git reset -- "$file"
            staged_size=0
        fi
    done < <(git ls-files --modified --others --exclude-standard)

    # Commit any remaining staged files
    if ! git diff --cached --quiet; then
        commit_and_push
    fi
}

# Check if there are changes to commit
if git diff --quiet && git diff --cached --quiet; then
    echo "No changes to commit. Exiting."
    exit 0
fi

stage_and_commit

echo "All changes committed."
