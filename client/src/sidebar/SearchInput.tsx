import React from 'react';

/**
 * Search/filter input component for sidebar.
 * 
 * Simple text input field that appears at top of sidebar when search is active.
 * Allows user to filter channels/docs by name (though actual filtering logic
 * is typically handled by parent component, not this component itself).
 * 
 * @component
 * @param {Object} props - Component props
 * @param {boolean} props.isVisible - Whether input should be displayed
 * @param {string} props.searchQuery - Current search text
 * @param {Function} props.setSearchQuery - Callback to update search text
 * @param {Function} props.onSubmit - Callback when Enter is pressed
 */
interface SearchInputProps {
  isVisible: boolean;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  onSubmit?: (query: string) => void;
}

const SearchInput: React.FC<SearchInputProps> = ({
  isVisible,
  searchQuery,
  setSearchQuery,
  onSubmit
}) => {
  if (!isVisible) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchQuery.trim() && onSubmit) {
      onSubmit(searchQuery.trim());
    }
  };

  return (
    <div style={{ padding: '0.5em 0' }}>
      <input
        type="text"
        placeholder="Search netdocs..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          padding: '6px 8px',
          fontSize: '12px',
          background: '#1a1410',
          color: 'var(--main-text)',
          border: '1px solid #c1a263',
          borderRadius: '4px',
          boxSizing: 'border-box'
        }}
      />
    </div>
  );
};

export default SearchInput;

