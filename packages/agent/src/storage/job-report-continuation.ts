/** Private host continuation admission; never a model/client command. */
export interface ContinueHumanWorkInput {
  decisionCommandId: string;
  subjectId: string;
  controlRevision: string;
}
