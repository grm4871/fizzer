import { useNavigate } from 'react-router-dom';

interface UserSplashProps {
  displayName?: string;
  username?: string;
  style?: React.CSSProperties;
}

export default function UserSplash({ displayName, username, style }: UserSplashProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (username) {
      navigate(`/id/${username}`);
    }
  };

  return (
    <div className="user-splash" style={style}>
      <strong className="user-splash-name">{displayName || 'Anonymous'}</strong>
      {' '}
      <button type="button" onClick={handleClick} className="user-splash-link clickable">
        @{username || 'anonymous'}
      </button>
    </div>
  );
}
