import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion';
import { MessageContent } from '../MessageContent';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
type Option = { id?: string; label: string; description?: string };
type Question = {
  id: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Option[];
};
function options(value: unknown): Option[] {
  return Array.isArray(value)
    ? value.flatMap((value) => {
        const item = object(value);
        return item && typeof item.label === 'string'
          ? [
              {
                label: item.label,
                ...(typeof item.id === 'string' ? { id: item.id } : {}),
                ...(typeof item.description === 'string' ? { description: item.description } : {}),
              },
            ]
          : [];
      })
    : [];
}
function SavedAnswer({ value, choices = [] }: { value: unknown; choices?: Option[] }) {
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((value, index) => (
          <li key={index}>
            <SavedAnswer value={value} choices={choices} />
          </li>
        ))}
      </ul>
    ) : (
      <p>未选择选项（空数组）。</p>
    );
  if (typeof value === 'string') {
    const option = choices.find(
      (option) => option.id === value || (!option.id && option.label === value),
    );
    return value.length ? (
      <MessageContent text={option?.label ?? value} streaming={false} />
    ) : (
      <p>已保存空字符串。</p>
    );
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return <p>{String(value)}</p>;
  const item = object(value);
  if (item && Object.keys(item).length === 1 && typeof item.text === 'string')
    return <SavedAnswer value={item.text} />;
  if (
    item &&
    typeof item.question === 'string' &&
    Object.hasOwn(item, 'answer') &&
    Object.keys(item).every((key) => key === 'question' || key === 'answer')
  )
    return (
      <section>
        <h4>{item.question}</h4>
        <SavedAnswer value={item.answer} />
      </section>
    );
  return (
    <details>
      <summary>已保存的答复（JSON）</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/** Only already-admitted original public request/answer data. Never reads current tool settings. */
export function TrajectoryInteraction({
  data,
  cancelled = false,
}: {
  data: unknown;
  cancelled?: boolean;
}) {
  const saved = object(data),
    request = object(saved?.request),
    answer = object(saved?.answer);
  const action = object(request?.action);
  const shellAction =
    action?.kind === 'shell' && typeof action.command === 'string' ? action : undefined;
  const requestOptions = options(request?.options);
  const questions: Question[] = Array.isArray(request?.questions)
    ? request.questions.flatMap((value) => {
        const item = object(value);
        return item && typeof item.id === 'string' && typeof item.question === 'string'
          ? [
              {
                id: item.id,
                question: item.question,
                options: options(item.options),
                ...(typeof item.header === 'string' ? { header: item.header } : {}),
                ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
              },
            ]
          : [];
      })
    : [];
  const responses = answer && Object.hasOwn(answer, 'answers') ? answer.answers : undefined;
  const keyed = object(responses);
  const ids = new Set(questions.map((question) => question.id));
  const extra = keyed ? Object.keys(keyed).filter((id) => !ids.has(id)) : [];
  const requestText = [
    ...new Set(
      ['title', 'description', 'prompt', 'question', 'content'].flatMap((key) =>
        typeof request?.[key] === 'string' ? [request[key] as string] : [],
      ),
    ),
  ];
  const decision =
    typeof answer?.decision === 'string'
      ? ({ approve: '已批准', deny: '已拒绝', revise: '要求修改' } as Record<string, string>)[
          answer.decision
        ]
      : undefined;
  const selectedOption =
    typeof answer?.optionId === 'string'
      ? requestOptions.find((option) => option.id === answer.optionId)
      : undefined;
  const entries = questions.map((question, index) => ({ value: `question-${index}`, question }));
  const hasPublicAnswer =
    !!answer &&
    (decision !== undefined ||
      typeof answer.optionId === 'string' ||
      typeof answer.feedback === 'string' ||
      Object.hasOwn(answer, 'answers'));
  const answerFields =
    decision !== undefined ||
    typeof answer?.optionId === 'string' ||
    typeof answer?.feedback === 'string';
  const showResponses =
    responses !== undefined && (!keyed || (!questions.length && Object.keys(keyed).length === 0));
  const showAnswer = answerFields || showResponses || (!questions.length && !keyed);
  return (
    <section aria-label="审批与问答内容">
      {cancelled && <p role="status">此交互已取消。</p>}
      <Accordion
        className="trajectory-content-accordion"
        type="multiple"
        defaultValue={[
          ...entries.map((entry) => entry.value),
          ...(questions.length ? [] : ['request']),
          ...(showAnswer ? ['answer'] : []),
          ...extra.map((_, index) => `extra-${index}`),
        ]}
      >
        {!questions.length && (
          <AccordionItem value="request">
            <AccordionTrigger>请求内容</AccordionTrigger>
            <AccordionContent>
              {requestText.map((text, index) => (
                <MessageContent key={index} text={text} streaming={false} />
              ))}
              {shellAction && (
                <section aria-label="原审批命令">
                  <pre>{shellAction.command as string}</pre>
                  <dl>
                    {typeof shellAction.workdir === 'string' && (
                      <>
                        <dt>工作目录</dt>
                        <dd>{shellAction.workdir}</dd>
                      </>
                    )}
                    {['workspace_write', 'full_access'].includes(
                      String(shellAction.filesystem),
                    ) && (
                      <>
                        <dt>文件范围</dt>
                        <dd>
                          {shellAction.filesystem === 'workspace_write'
                            ? '工作区及允许的临时目录'
                            : '请求工作区外写入'}
                        </dd>
                      </>
                    )}
                    {['none', 'internet'].includes(String(shellAction.network)) && (
                      <>
                        <dt>网络范围</dt>
                        <dd>
                          {shellAction.network === 'none' ? '不请求网络访问' : '请求网络访问'}
                        </dd>
                      </>
                    )}
                  </dl>
                </section>
              )}
              {requestOptions.length > 0 && (
                <details>
                  <summary>原审批选项</summary>
                  <ul>
                    {requestOptions.map((option, index) => (
                      <li key={index}>
                        <span>{option.label}</span>
                        {option.description && <p>{option.description}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!requestText.length && !shellAction && !requestOptions.length && (
                <p>此版本未保存可展示的请求说明。</p>
              )}
            </AccordionContent>
          </AccordionItem>
        )}
        {entries.map(({ value, question }) => (
          <AccordionItem value={value} key={value}>
            <AccordionTrigger>{question.header || question.question}</AccordionTrigger>
            <AccordionContent>
              {question.header && <MessageContent text={question.question} streaming={false} />}
              {question.options.length > 0 && (
                <details>
                  <summary>{question.multiSelect ? '原多选选项' : '原选项'}</summary>
                  <ul>
                    {question.options.map((option, index) => (
                      <li key={index}>
                        <span>{option.label}</span>
                        {option.description && <p>{option.description}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <h4>已保存的答复</h4>
              {keyed && Object.hasOwn(keyed, question.id) ? (
                <SavedAnswer value={keyed[question.id]} choices={question.options} />
              ) : (
                <p>{cancelled ? '此版本没有答复。' : '此问题尚未保存答复。'}</p>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
        {extra.map((id, index) => (
          <AccordionItem value={`extra-${index}`} key={id}>
            <AccordionTrigger>{id}</AccordionTrigger>
            <AccordionContent>
              <SavedAnswer value={keyed![id]} />
            </AccordionContent>
          </AccordionItem>
        ))}
        {showAnswer && (
          <AccordionItem value="answer">
            <AccordionTrigger>{hasPublicAnswer ? '已保存的答复' : '答复'}</AccordionTrigger>
            <AccordionContent>
              {decision && <p>{decision}</p>}
              {typeof answer?.optionId === 'string' && (
                <p>所选选项：{selectedOption?.label ?? answer.optionId}</p>
              )}
              {typeof answer?.feedback === 'string' && (
                <section>
                  <h4>反馈</h4>
                  <SavedAnswer value={answer.feedback} />
                </section>
              )}
              {showResponses && <SavedAnswer value={responses} />}
              {!hasPublicAnswer && <p>{cancelled ? '此版本没有答复。' : '此版本尚未保存答复。'}</p>}
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </section>
  );
}
