import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SidebarItem } from '../types';

import { apiFetch } from '../utils/api';
/**
 * Custom hook for managing netdoc creation modal and submission.
 *
 * Handles:
 * - Modal visibility state
 * - Title input for new netdoc
 * - API calls to create netdoc and subscribe to it
 *
 * @param {Function} _setItems - Setter for items array (unused but kept for signature)
 * @param {Function} [onNetdocCreated] - Optional callback when netdoc is created
 * @returns {Object} Modal state and submission function
 */
export const useSidebarNetdocs = (
  _setItems: (items: SidebarItem[] | ((prev: SidebarItem[]) => SidebarItem[])) => void,
  onNetdocCreated?: (netdocId: string, netdocName: string) => void
) => {
  const navigate = useNavigate();
  const [showNetdocInput, setShowNetdocInput] = useState(false);
  const [netdocInputTitle, setNetdocInputTitle] = useState('');

  const openNetdocInput = () => {
    setNetdocInputTitle('');
    setShowNetdocInput(true);
  };

  const closeNetdocInput = () => {
    setShowNetdocInput(false);
    setNetdocInputTitle('');
  };

  /**
   * Create a new netdoc and subscribe to it.
   */
  const submitNetdocCreate = async (
    userId: string,
    fetchSidebarData: () => Promise<void>
  ) => {
    if (!netdocInputTitle.trim() || !userId) {
      closeNetdocInput();
      return;
    }

    try {
      const createRes = await apiFetch('/api/netdoc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name: netdocInputTitle.trim() })
      });
      if (!createRes.ok) throw new Error(await createRes.text());
      const netdoc = await createRes.json();

      // Subscribe to netdoc
      const subscribeRes = await apiFetch(`/api/subscriptions/${userId}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netdocId: netdoc.id })
      });
      if (!subscribeRes.ok) {
        console.error('Failed to subscribe new netdoc');
      }

      await fetchSidebarData();

      if (onNetdocCreated) {
        onNetdocCreated(netdoc.id, netdoc.name || 'Netdoc');
      } else {
        navigate(`/netdoc/${netdoc.id}`);
      }

      closeNetdocInput();
    } catch (err) {
      console.error('Failed creating netdoc:', err);
    }
  };

  return {
    showNetdocInput,
    setShowNetdocInput,
    netdocInputTitle,
    setNetdocInputTitle,
    openNetdocInput,
    closeNetdocInput,
    submitNetdocCreate
  };
};
