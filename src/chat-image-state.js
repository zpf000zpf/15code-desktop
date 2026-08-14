'use strict';

// This module is intentionally dependency-free: the renderer uses it through the
// browser global and the regression suite imports the exact same implementation.
(function exposeChatImageState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatImageState = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  function titleForMessages(messages) {
    const first = messages.find(message => message.role === 'user' && message.content?.trim());
    const text = (first?.content || '新对话').replace(/\s+/g, ' ').trim();
    return text.length > 36 ? text.slice(0, 36) + '…' : text;
  }

  // Returns the one conversation snapshot allowed to receive an asynchronous image
  // result. If that conversation was reopened, merge by stable message ID so newer
  // messages and its draft are retained. All inputs and returned messages are plain
  // data; no DOM, IPC, or image API access is involved.
  function finalizeImageOperation({ operationConversationId, imageMessageId, operationMessages,
    operationModel, finishedImage, currentConversationId, currentMessages, currentModel, currentDraft }) {
    const stillCurrentConversation = currentConversationId === operationConversationId;
    let messages = operationMessages;
    if (stillCurrentConversation && currentMessages !== operationMessages
      && currentMessages.some(message => message.id === imageMessageId)) {
      messages = currentMessages.map(message => message.id === imageMessageId
        ? { ...message, type: 'image', image: { ...finishedImage } }
        : message);
    }
    return {
      stillCurrentConversation,
      messages,
      snapshot: {
        id: operationConversationId,
        title: titleForMessages(messages),
        model: stillCurrentConversation ? currentModel : operationModel,
        draft: stillCurrentConversation ? (currentDraft || '') : '',
        messages: messages.map(message => ({ ...message, image: message.image ? { ...message.image } : undefined })),
      },
    };
  }

  return { finalizeImageOperation };
});
