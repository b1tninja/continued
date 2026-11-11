import styled from "styled-components";
import { defaultBorderRadius, lightGray, vscForeground } from "../..";
import { getFontSize } from "../../../util";

export const NewSessionButton = styled.div`
  width: fit-content;
  margin-right: auto;
  margin-left: 6px;
  margin-top: 2px;
  margin-bottom: 8px;
  font-size: ${getFontSize() - 2}px;

  border-radius: ${defaultBorderRadius};
  padding: 2px 6px;
  min-height: 24px;
  display: flex;
  align-items: center;
  /* 4.5:1 on both themes; lightGray was 2.7:1 on white */
  color: var(--vscode-descriptionForeground, #b3b3b3);

  &:hover {
    background-color: ${lightGray}33;
    color: ${vscForeground};
  }

  cursor: pointer;
`;
