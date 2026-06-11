import { useEffect } from 'react';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { Notification } from '../types';

interface UseSocketEventsProps {
  profileId: string;
  setNotifications: React.Dispatch<React.SetStateAction<Notification[]>>;
  setUnreadNotificationCount: React.Dispatch<React.SetStateAction<number>>;
  setQueuePosition: React.Dispatch<React.SetStateAction<number>>;
  fetchSidebarItems: () => void;
}

export function useSocketEvents({
  profileId,
  setNotifications,
  setUnreadNotificationCount,
  setQueuePosition,
  fetchSidebarItems
}: UseSocketEventsProps) {

  // ===== SOCKET CONNECTION =====
  useEffect(() => {
    if (profileId) {
      connectSocket(profileId);
    }

    // Handle window close/refresh to properly disconnect socket
    const handleDisconnect = () => {
      disconnectSocket();
    };

    window.addEventListener('beforeunload', handleDisconnect);
    window.addEventListener('pagehide', handleDisconnect);

    return () => {
      window.removeEventListener('beforeunload', handleDisconnect);
      window.removeEventListener('pagehide', handleDisconnect);
      disconnectSocket();
    };
  }, [profileId]);

  // ===== NOTIFICATION:NEW EVENTS =====
  useEffect(() => {
    if (!socket) return;

    const handleNewNotification = (data: any) => {
      console.log('[Socket] Received notification:new', data);
      
      const notification: Notification = {
        id: data.id,
        type: data.type || 'update',
        message: data.message,
        timestamp: new Date(data.timestamp || Date.now()),
        read: data.read || false,
        netdocId: data.netdocId,
        netdocName: data.netdocName,
        authorName: data.authorName,
        authorColor: data.authorColor,
        updateType: data.updateType,
        content: data.content
      };

      setNotifications(prev => [notification, ...prev]);
      setUnreadNotificationCount(prev => prev + 1);
    };

    socket.on('notification:new', handleNewNotification);

    return () => {
      socket.off('notification:new', handleNewNotification);
    };
  }, [setNotifications, setUnreadNotificationCount]);

  // ===== QUEUE POSITION =====
  useEffect(() => {
    if (!socket) return;

    const handleQueuePosition = (position: number) => {
      setQueuePosition(position);
      if (position === 0) {
        console.log('[Queue] You are now connected');
      } else {
        console.log(`[Queue] You are in position ${position}`);
      }
    };

    socket.on('queue-position', handleQueuePosition);

    return () => {
      socket.off('queue-position', handleQueuePosition);
    };
  }, [setQueuePosition]);

  // ===== SIDEBAR SUBSCRIPTIONS =====
  useEffect(() => {
    if (!socket) return;

    const handleSubscriptionAdded = () => {
      console.log('[Socket] Received sidebar:subscription-added event, refetching sidebar');
      fetchSidebarItems();
    };

    const handleSubscriptionRemoved = () => {
      console.log('[Socket] Received sidebar:subscription-removed event, refetching sidebar');
      fetchSidebarItems();
    };

    socket.on('sidebar:subscription-added', handleSubscriptionAdded);
    socket.on('sidebar:subscription-removed', handleSubscriptionRemoved);

    return () => {
      socket.off('sidebar:subscription-added', handleSubscriptionAdded);
      socket.off('sidebar:subscription-removed', handleSubscriptionRemoved);
    };
  }, [fetchSidebarItems]);

}
