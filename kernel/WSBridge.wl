(* Kernel side of the WebSocket bridge: decodes a WXF request, evaluates it and returns an
   Association. A request may use any function, as in a notebook, and runs without time or memory
   limits; what it defines stays for later requests. Loaded with -initfile. *)

BeginPackage["WSBridge`"];

EvaluateRequest::usage = "EvaluateRequest[bytes] evaluates the WXF-encoded expression in the ByteArray bytes. A String is parsed as Wolfram Language input first.";
Serve::usage = "Serve[endpoint] connects a ZMQ PAIR socket to endpoint, sends \"ready\" and then answers every request message with the WXF of EvaluateRequest[message], forever.";

Begin["`Private`"];

failure[type_String, message_String] := <|"Success" -> False, "Failure" -> type, "Message" -> message|>;

(* a String request is Wolfram Language input: parse it in the session's contexts, without
   evaluating anything *)
parse[HoldComplete[s_String]] := Replace[Quiet @ ToExpression[s, InputForm, HoldComplete], {
  h_HoldComplete :> h,
  _ :> failure["Syntax", "The input could not be parsed."]}];
parse[held_HoldComplete] := held;

(* one line per message, arguments in InputForm: "Power::infy: Infinite expression 1/0 encountered." *)
argText[HoldCompleteForm[e_]] := ToString[Unevaluated[e], InputForm];
argText[e_] := ToString[e, InputForm];
messageText[Hold[Message[MessageName[s_Symbol, tag_String], args___]]] := Quiet @ Module[
  {name = SymbolName[Unevaluated[s]] <> "::" <> tag, template = MessageName[s, tag], texts = argText /@ {args}},
  If[!StringQ[template], template = MessageName[General, tag]];
  name <> ": " <> If[StringQ[template], ToString[StringForm[template, Sequence @@ texts]], StringRiffle[texts, " "]]];
messageText[other_] := ToString[other, InputForm];

(* How a result is shown on a web page: graphics as an SVG picture (PNG for raster images),
   everything else as TeX for KaTeX. Formatting runs after the evaluation and never fails a
   request: when it does not work, the reply has neither field. *)
$graphics = _Graphics | _Graphics3D | _Legended | _GraphicsRow | _GraphicsColumn | _GraphicsGrid | _Graph | _Image;
(* Not limits on what is evaluated or sent: these only choose how it is shown. *)
$texSize = 20000;      (* larger results (leaves, TeX characters) are not typeset: the InputForm text is there in full *)
$svgSize = 500000;     (* larger SVGs (dense contour or density plots) become a PNG inside an SVG *)

display[result_Image] := imageData["PNG", ExportByteArray[result, "PNG"]];
display[result_ /; !FreeQ[result, $graphics]] := imageData["SVG", svg[result]];   (* also {plot1, plot2} *)
display[result_] := If[LeafCount[result] > $texSize, <||>,
  With[{t = tex[result]}, If[StringQ[t] && StringLength[t] <= $texSize, <|"TeX" -> t|>, <||>]]];
imageData[format_, data_] := If[StringQ[data] || ByteArrayQ[data], <|"Image" -> <|"Format" -> format, "Data" -> data|>|>, <||>];

(* Cairo draws a dense mesh of polygons as megabytes of paths with hairline seams between them;
   such a picture is sent as a PNG at twice the resolution, wrapped in an SVG of the same size *)
svg[g_] := Module[{s, image, png, w, h},
  s = ExportString[g, "SVG"];
  (* a kernel whose export machinery was broken by an earlier abort fails every export *)
  If[!StringQ[s] && !StringQ[Quiet @ ExportString[Graphics[], "SVG"]], $restart = True];
  If[!StringQ[s] || StringLength[s] <= $svgSize, Return[s]];
  image = Rasterize[g, ImageResolution -> 144];
  png = If[ImageQ[image], ExportByteArray[image, "PNG"], $Failed];
  If[!ByteArrayQ[png], Return[s]];
  {w, h} = ImageDimensions[image] / 2;
  {w, h} = If[IntegerQ[#], IntegerString[#], ToString[N[#]]] & /@ {w, h};
  StringTemplate["<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"`1`pt\" height=\"`2`pt\" viewBox=\"0 0 `1` `2`\"><image width=\"`1`\" height=\"`2`\" href=\"data:image/png;base64,`3`\"/></svg>"][
    w, h, BaseEncode[png]]];

(* TeXForm without a front end mishandles some things: other characters than ASCII in strings,
   association keys, reals of at most 10^-5 (shown as InputForm text), Root and RootSum objects,
   the brackets of associations and some operators (\unicode{...} of private-use characters,
   which KaTeX does not know). Those parts are replaced by placeholder strings, which TeXForm
   prints as \text{wsb-tex-n}, and their own TeX is put in afterwards. "-" cannot occur in a
   symbol name. Small reals and the approximate values of roots go in as expressions instead
   (ScientificForm, TildeTilde), so that TeXForm puts parentheses around them where needed. *)
tex[e_] := Module[{n = 0, held, parts, boxes, out},
  {held, parts} = Reap[ReplaceAll[markAlone[With[{x = e}, HoldForm[x]]], {
    s_String :> With[{v = part[textTeX[s], n]}, v /; True],
    a_Association?AssociationQ :> With[{v = part[associationTeX[a], n]}, v /; True],
    r_Real /; tinyQ[r] :> With[{v = scientific[r]}, v /; True],
    Complex[a_Real, b_Real] /; tinyQ[a] || tinyQ[b] :> With[{x = scientific[a], y = scientific[b]}, x + y I /; True],
    r : Root[f_Function, k_Integer, ___] :> With[{v = approximately[part[rootTeX[f, k], n], r]}, v /; True],
    RootSum[f_Function, g_Function] :> With[{v = part[rootSumTeX[f, g], n]}, v /; True],
    alone[ConditionalExpression[a_, c_]] :> With[{v = part[conditionTeX[a, c], n]}, v /; True],
    ConditionalExpression[a_, c_] :> With[{v = part["\\left(" <> conditionTeX[a, c] <> "\\right)", n]}, v /; True],
    (* TeXForm draws any list of equal-length lists as one matrix, also {values, vectors} or a list of matrices *)
    l : {__List} /; !MatrixQ[l] && SameQ @@ (Length /@ l) :>
      With[{v = part["\\left\\{" <> StringRiffle[tex /@ l, ","] <> "\\right\\}", n]}, v /; True]}]];
  (* TeXForm's conversion of boxes slows down sharply with the length of a row (seconds for
     Range[1000]); long rows are split into nested rows of 64, which gives the same TeX *)
  boxes = ToBoxes[held, TraditionalForm];
  out = If[FreeQ[boxes, RowBox[l_List /; Length[l] > 64]], ToString[TeXForm[held]],
    Convert`TeX`BoxesToTeX[boxes //. RowBox[l_List /; Length[l] > 64] :> RowBox[RowBox /@ Partition[l, UpTo[64]]]]];
  If[!StringQ[out], Return[$Failed]];
  out = StringReplace[out, Flatten[parts]];
  StringReplace[out, {
    "\\unicode{" ~~ hex : HexadecimalCharacter .. ~~ "}" :> unicodeTeX[FromDigits[hex, 16]],
    "\\left[\\right]" -> "[\\ldots]"}]];   (* summary boxes: SparseArray, InterpolatingFunction... *)
(* applies rules to a result inside HoldForm, so that a changed Integrate[...] does not run again;
   a rule's With[{v = ...}, v /; True] evaluates the replacement before it goes in *)
inside[e_, rules_] := ReplaceAll[With[{x = e}, HoldForm[x]], rules];
SetAttributes[part, HoldRest];
part[t_String, n_] := With[{name = "wsb-tex-" <> IntegerString[++n]}, Sow["\\text{" <> name <> "}" -> t]; name];

tinyQ[r_] := r != 0 && Abs[r] <= 10^-5;   (* <=: an arbitrary-precision 1.`20*^-5 is not < 10^-5 *)
scientific[r_Real] := Which[!tinyQ[r], r, MachineNumberQ[r], ScientificForm[r], True, ScientificForm[r, Round[Precision[r]]]];
scientific[r_] := r;
(* Root(...) ≈ value, as a relation that TeXForm puts in parentheses inside a sum or product *)
approximately[p_, r_] := With[{v = Quiet @ N[r]}, Which[
  Head[v] === Real, TildeTilde[p, scientific[v]],
  MatchQ[v, Complex[a_Real, b_Real] /; tinyQ[a] || tinyQ[b]],
    With[{x = scientific[Re[v]], y = scientific[Im[v]]}, TildeTilde[p, HoldForm[x + y I]]],
  NumberQ[v], TildeTilde[p, v],
  True, p]];
(* in KaTeX's text mode, characters such as \[Integral] would be math commands: other characters
   than printable ASCII go in as {\char"hex} *)
textTeX[s_String] := "\\text{" <> StringReplace[s, {
  "\\" -> "\\textbackslash{}", "^" -> "\\textasciicircum{}", "~" -> "\\textasciitilde{}",
  c : Alternatives @@ Characters["{}$&%#_"] :> "\\" <> c, WhitespaceCharacter -> " ",
  c : RegularExpression["[^ -~]"] :> "{\\char\"" <> IntegerString[First @ ToCharacterCode[c], 16] <> "}"}] <> "}";
(* keys and values each get their own TeX: ReplaceAll does not reach the keys *)
associationTeX[a_] := "\\langle|" <> StringRiffle[Replace[Normal[a], {
    Rule[k_, v_] :> tex[k] <> "\\to " <> tex[v],
    RuleDelayed[k_, v_] :> tex[k] <> ":\\to " <> tex[v]}, {1}], ","] <> "|\\rangle";
rootTeX[f_, k_] := "\\operatorname{Root}\\left(" <> tex[f[\[FormalX]]] <> ",\\," <> IntegerString[k] <> "\\right)";
rootSumTeX[f_, g_] := "\\sum_{\\alpha:\\," <> tex[f[\[FormalAlpha]]] <> "=0}" <> tex[g[\[FormalAlpha]]];
conditionTeX[a_, c_] := tex[a] <> "\\quad\\text{if }" <> tex[c];
(* ConditionalExpression reads as "a if c" where it stands alone: the whole result, a list
   element or the right side of a rule. Elsewhere it goes in parentheses. *)
markAlone[held_] := With[{positions = Select[Position[held, _ConditionalExpression, Heads -> False], aloneQ[held, #] &]},
  If[positions === {}, held, MapAt[alone, held, positions]]];
aloneQ[_, {1}] := True;
aloneQ[held_, p_] := With[{h = Extract[held, Append[Most[p], 0], HoldComplete]},
  h === HoldComplete[List] || (MatchQ[h, HoldComplete[Rule | RuleDelayed]] && Last[p] === 2)];
unicodeTeX[16^^f113] = "\\langle|";            (* association brackets *)
unicodeTeX[16^^f114] = "|\\rangle";
unicodeTeX[16^^f4a1] = "\\mapsto ";            (* Function *)
unicodeTeX[16^^f854] = "\\alpha ";             (* \[FormalAlpha], in RootSum *)
unicodeTeX[c_ /; 16^^f800 <= c <= 16^^f819] := FromCharacterCode[c - 16^^f800 + 97];    (* \[FormalA]... *)
unicodeTeX[c_ /; 16^^f81a <= c <= 16^^f833] := FromCharacterCode[c - 16^^f81a + 65];    (* \[FormalCapitalA]... *)
unicodeTeX[c_ /; 16^^e000 <= c <= 16^^f8ff] := "\\square ";
unicodeTeX[c_] := textTeX[FromCharacterCode[c]];

(* the InputForm text of a picture is its OutputForm (-Graphics-): the picture is the content *)
marker[Legended[g_, ___]] := marker[g];
marker[g_] := "-" <> SymbolName[Head[g]] <> "-";
resultText[result : $graphics] := marker[result];
resultText[result_ /; !FreeQ[result, $graphics]] := StringReplace[
  Replace[inside[result, g : $graphics :> With[{v = marker[g]}, v /; True]], HoldForm[x_] :> ToString[Unevaluated[x], InputForm]],
  "\"" ~~ m : ("-" ~~ LetterCharacter .. ~~ "-") ~~ "\"" :> m];
resultText[result_] := ToString[result, InputForm];

(* An abort in the middle of an export (TimeConstrained around one, say) leaves this kernel unable
   to export anything again (Export returns Null at once, also with a new front end). Serve then
   tells the bridge to replace the kernel, sends the reply and exits. *)
$restart = False;

(* Input of several expressions is evaluated like a;b;c. Nothing may escape to the request loop: an
   uncaught Throw, Break, Continue, Goto... becomes the result, held; a Return or Sequence that is
   left over is held too. An abort goes on to Serve. *)
together[held : HoldComplete[_]] := held;
together[HoldComplete[e__]] := HoldComplete[CompoundExpression[e]];
together[_] := HoldComplete[Null];
evaluate[held_] := CheckAll[{ReleaseHold[held]}, evaluated];
evaluated[_, Hold[___, Abort[], ___]] := Abort[];
evaluated[r_, Hold[]] := Replace[r, {{} -> Null, {x_Return} :> Hold[x], {x_} :> x, {x__} :> Hold[Sequence[x]]}];
evaluated[_, control_] := control;

run[held_HoldComplete] := Module[{data, result, shown, text},
  (* a fresh $MessageList per request: the kernel lives on between requests, and a message
     already seen three times would otherwise stay suppressed by General::stop *)
  data = With[{h = together[held]}, Block[{$MessageList = {}}, EvaluationData[evaluate[h]]]];
  result = data["Result"];
  (* an abort here costs only the picture or TeX *)
  shown = CheckAbort[Quiet[display[result]], $Aborted];
  If[!AssociationQ[shown], shown = <|"Format" -> "Aborted"|>];
  text = CheckAbort[Quiet[resultText[result]], $Aborted];
  If[!StringQ[text], text = "-NoText-"];
  Join[<|"Success" -> True, "Result" -> result, "InputForm" -> text,
    "Messages" -> (messageText /@ data["MessagesExpressions"]), "Timing" -> data["AbsoluteTiming"]|>, shown]];

(* a HoldComplete, or a failure; a name in two contexts (Global`x and a new System`x) is not one.
   BinaryDeserialize reads a name without a context as System`name and creates it if needed. *)
read[bytes_] := With[{held = Quiet @ Check[Quiet[BinaryDeserialize[bytes, HoldComplete], General::shdw], $Failed]},
  If[MatchQ[held, _HoldComplete], parse[held], failure["Decode", "The request is not valid WXF."]]];

EvaluateRequest[bytes_ByteArray] := Replace[read[bytes], h_HoldComplete :> run[h]];
EvaluateRequest[_] := failure["Decode", "The request must be a ByteArray."];

(* The request loop. Every step runs under CheckAbort: an abort must not end the loop. *)
Serve[endpoint_String] := Module[{socket, request, reply},
  socket = SocketConnect[endpoint, "ZMQ_Pair"];
  If[FailureQ[socket], Print["cannot connect to ", endpoint]; Exit[3]];
  (* the first SVG and PNG exports and TeXForm of a session take seconds: pay that before "ready" *)
  Quiet[ExportString[Plot[x, {x, 0, 1}], "SVG"]; ExportByteArray[Image[{{0., 1.}}], "PNG"]; ToString[TeXForm[Sqrt[x]/2]]];
  (* typed names are looked up like in a new session, without this package's own *)
  $Context = "Global`"; $ContextPath = {"System`", "Global`"};
  SocketWriteMessage[socket, StringToByteArray["ready"]];
  While[True,
    request = CheckAbort[SocketReadMessage[socket], $Aborted];
    If[!ByteArrayQ[request], Continue[]];
    reply = CheckAbort[EvaluateRequest[request], failure["Aborted", "The evaluation was aborted."]];
    reply = CheckAbort[BinarySerialize[reply],
      BinarySerialize[failure["Aborted", "The reply could not be serialized."]]];
    (* "restart" comes before the reply, so that the bridge knows before it sends another request *)
    AbortProtect[If[$restart, SocketWriteMessage[socket, StringToByteArray["restart"]]]; SocketWriteMessage[socket, reply]];
    If[$restart, Quiet[Close[socket]]; Exit[0]]]];

End[];
EndPackage[];
