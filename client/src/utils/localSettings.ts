// Apply spellcheck setting from localStorage
export function applySpellcheckSetting() {
    const savedSettings = localStorage.getItem('localsettings');
    let spellcheckEnabled = false; // Default to false (off)

    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            // When misspellIndicator is "on", enable spellcheck
            spellcheckEnabled = settings.misspellIndicator === true;
        } catch (error) {
            console.error('Failed to parse localsettings:', error);
        }
    }

    // Set data attribute on html element
    document.documentElement.setAttribute('data-spellcheck', String(spellcheckEnabled));

    // Also set spellcheck attribute on all relevant elements
    const elements = document.querySelectorAll('input, textarea, [contenteditable]');
    elements.forEach(element => {
        element.setAttribute('spellcheck', String(spellcheckEnabled));
    });
}

// Initialize settings on load
export function initializeLocalSettings() {
    applySpellcheckSetting();

    // Re-apply when new elements are added (for dynamic content)
    const observer = new MutationObserver(() => {
        applySpellcheckSetting();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}
