import React from 'react';


interface MobileNavBarProps {
    onToggleSidebar: () => void;
    onBack: () => void;
    onForward: () => void;
    canGoBack: boolean;
    canGoForward: boolean;
}

const MobileNavBar: React.FC<MobileNavBarProps> = ({
    onToggleSidebar,
    onBack,
    onForward,
    canGoBack,
    canGoForward,
}) => {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'stretch',
            background: '#111',
            borderBottom: '1px solid #c1a263',
            height: '40px', // Matches typical tab height
            padding: '0 8px'
        }}>
            {/* Left section: Navigation Controls */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                height: '100%'
            }}>
                {/* Back Button */}
                <button
                    onClick={onBack}
                    disabled={!canGoBack}
                    style={{
                        width: '32px',
                        height: '32px',
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        cursor: canGoBack ? 'pointer' : 'default',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: canGoBack ? 1 : 0.3
                    }}
                    title="Go Back"
                >
                    <span style={{
                        display: 'inline-block',
                        borderTop: '2px solid #c1a263',
                        borderLeft: '2px solid #c1a263',
                        width: '10px',
                        height: '10px',
                        transform: 'rotate(-45deg)',
                        marginLeft: '4px'
                    }} />
                </button>

                {/* Forward Button */}
                <button
                    onClick={onForward}
                    disabled={!canGoForward}
                    style={{
                        width: '32px',
                        height: '32px',
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        cursor: canGoForward ? 'pointer' : 'default',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: canGoForward ? 1 : 0.3
                    }}
                    title="Go Forward"
                >
                    <span style={{
                        display: 'inline-block',
                        borderTop: '2px solid #c1a263',
                        borderRight: '2px solid #c1a263',
                        width: '10px',
                        height: '10px',
                        transform: 'rotate(45deg)',
                        marginRight: '4px'
                    }} />
                </button>
            </div>

            {/* Spacer to push sidebar toggle to right */}
            <div style={{ flex: 1 }} />

            {/* Right section: Sidebar Toggle */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                height: '100%'
            }}>
                {/* Vertical Divider */}
                <div style={{ width: '1px', height: '20px', background: '#333' }} />

                {/* Hamburger / Sidebar Toggle */}
                <button
                    onClick={onToggleSidebar}
                    style={{
                        width: '32px',
                        height: '32px',
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        gap: '5px',
                        alignItems: 'center'
                    }}
                    title="Open Sidebar"
                >
                    <div style={{ width: '20px', height: '2px', background: '#c1a263' }} />
                    <div style={{ width: '20px', height: '2px', background: '#c1a263' }} />
                    <div style={{ width: '20px', height: '2px', background: '#c1a263' }} />
                </button>
            </div>
        </div>
    );
};

export default MobileNavBar;
