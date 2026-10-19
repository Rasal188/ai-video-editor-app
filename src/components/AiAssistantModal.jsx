import { AiAssistantPanel } from "./AiAssistantPanel.jsx";

export function AiAssistantModal({
  isOpen,
  onClose,
  isExpanded,
  onToggleCollapse,
  ...props
}) {
  const activeExpanded = isExpanded !== undefined ? isExpanded : isOpen;
  const activeToggle = onToggleCollapse || onClose;

  return (
    <AiAssistantPanel
      isExpanded={activeExpanded}
      onToggleCollapse={activeToggle}
      {...props}
    />
  );
}

export { AiAssistantPanel };
export default AiAssistantPanel;
