#!/bin/bash

# Auto-pull script for staging branch
# This script monitors the remote staging branch and automatically pulls when updates are detected
# run from current working directory

REPO_DIR="$(pwd)"
BRANCH="staging"
CHECK_INTERVAL=30  # seconds between checks

cd "$REPO_DIR" || exit 1

echo "🚀 Starting auto-pull monitor for branch: $BRANCH"
echo "📁 Repository: $REPO_DIR"
echo "⏱️  Check interval: ${CHECK_INTERVAL}s"
echo "---"

# Ensure we're on the staging branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "$BRANCH" ]; then
    echo "⚠️  Current branch is '$current_branch', switching to '$BRANCH'..."
    git checkout "$BRANCH" || exit 1
fi

while true; do
    # Fetch the latest changes from remote
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking for updates..."
    git fetch origin "$BRANCH" --quiet
    
    # Get the commit hashes
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/"$BRANCH")
    
    # Compare local and remote
    if [ "$LOCAL" != "$REMOTE" ]; then
        echo "✨ Updates detected! Pulling changes..."
        
        # Check if there are local changes
        if ! git diff-index --quiet HEAD --; then
            echo "⚠️  Warning: You have uncommitted local changes!"
            echo "Stashing local changes..."
            git stash
            STASHED=true
        fi
        
        # Pull the changes
        git pull origin "$BRANCH"
        
        # Restore stashed changes if any
        if [ "$STASHED" = true ]; then
            echo "Restoring stashed changes..."
            git stash pop
            STASHED=false
        fi
        
        echo "✅ Pull completed successfully at $(date '+%Y-%m-%d %H:%M:%S')"
        echo "---"
    else
        echo "✓ No updates ($(date '+%H:%M:%S'))"
    fi
    
    # Wait before checking again
    sleep "$CHECK_INTERVAL"
done
