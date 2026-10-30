import { cloneElement, forwardRef, isValidElement } from 'react';
import type { ButtonHTMLAttributes, ComponentType, ReactElement, ReactNode, SVGProps } from 'react';

type ActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ComponentType<SVGProps<SVGSVGElement>> | ReactElement;
  children: ReactNode;
};

const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton({ icon, children, className, ...props }, ref) {
  const iconProps = { width: 14, height: 14, 'aria-hidden': true as const, focusable: false as const };
  const renderedIcon = isValidElement<SVGProps<SVGSVGElement>>(icon)
    ? cloneElement(icon, iconProps)
    : (() => { const Icon = icon as ComponentType<SVGProps<SVGSVGElement>>; return <Icon {...iconProps} />; })();

  return <button {...props} ref={ref} className={['action-button', className].filter(Boolean).join(' ')}>{renderedIcon}<span className="action-button-label">{children}</span></button>;
});

export default ActionButton;
