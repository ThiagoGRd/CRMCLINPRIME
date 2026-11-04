import React from 'react';
export const useSearchParams = () => new URLSearchParams(window.location.search);
export default function Link({href,children,...props}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {href:string}) {return <a href={href} {...props}>{children}</a>}
