(* Kernel side of the WebSocket bridge: decodes a WXF request, refuses anything outside the
   allowlist, evaluates it under time and memory limits and returns an Association.
   Loaded with -initfile; limits can be overridden by a later init file. *)

BeginPackage["WSBridge`"];

EvaluateRequest::usage = "EvaluateRequest[bytes] evaluates the WXF-encoded expression in the ByteArray bytes. A String is parsed as Wolfram Language input first.";
WSBridge`$TimeLimit::usage = "Seconds allowed per evaluation.";
WSBridge`$MemoryLimit::usage = "Bytes allowed per evaluation.";
WSBridge`$OutputLimit::usage = "Maximum length of the InputForm text of a result.";
WSBridge`$FormatTimeLimit::usage = "Seconds allowed for the TeX or picture of a result, after the evaluation.";
WSBridge`$ResultLimit::usage = "Largest result in bytes (ByteCount) that is sent back as an expression; a larger one comes without \"Result\".";
WSBridge`$Allowed::usage = "Association of allowed System` symbol names.";
Serve::usage = "Serve[endpoint] connects a ZMQ PAIR socket to endpoint, sends \"ready\" and then answers every request message with the WXF of EvaluateRequest[message], forever; after each reply it removes the Global` symbols that reading the request created.";

Begin["`Private`"];

$dir = DirectoryName[$InputFileName];
WSBridge`$TimeLimit = 30;
WSBridge`$MemoryLimit = 2*1024^3;
WSBridge`$OutputLimit = 100000;
WSBridge`$FormatTimeLimit = 20;
WSBridge`$ResultLimit = 16*1024^2;
WSBridge`$Allowed = AssociationMap[True &,
  Select[
    StringSplit[StringReplace[ReadString[FileNameJoin[{$dir, "allowlist.txt"}]], "#" ~~ Except["\n"] ... -> ""]],
    StringQ]];

failure[type_String, message_String, extra_ : <||>] :=
  Join[<|"Success" -> False, "Failure" -> type, "Message" -> message|>, extra];

(* Cases, FreeQ and Position look into the values of an association but not into its keys, and an
   association decoded from WXF is an atom whose keys are not evaluated until something such as
   Normal takes them out. These are the keys of every association in a held expression, each in
   HoldComplete, including the keys of associations inside keys. *)
heldKeys[held_] := With[{keys = Flatten @ Cases[held,
    a_Association /; AtomQ[Unevaluated[a]] :> Keys[a, HoldComplete], {0, Infinity}, Heads -> True]},
  Join[keys, Flatten[heldKeys /@ keys]]];
withKeys[held_HoldComplete] := Prepend[heldKeys[held], held];

(* fully qualified names of all symbols in a held expression, association keys included, that are not allowed *)
refused[held_HoldComplete] := Union @@ (Cases[#,
  s_Symbol :> With[{ctx = Quiet @ Context[Unevaluated[s]], name = SymbolName[Unevaluated[s]]},
    Which[
      ctx === "System`" && KeyExistsQ[WSBridge`$Allowed, name], Nothing,
      ctx === "Global`" && OwnValues[s] === {} && DownValues[s] === {} && UpValues[s] === {} &&
        SubValues[s] === {}, Nothing,
      (* WXF decodes a name it cannot take ("System`*") as a removed symbol *)
      StringQ[ctx], ctx <> name,
      True, "Removed[" <> name <> "]"]],
  {0, Infinity}, Heads -> True] & /@ withKeys[held]);

(* The front end reads linear box syntax (\!\(...\), \(...\), \*Box[...]) in the strings it draws:
   the labels, texts and legends of graphics. Strings holding it are refused in requests, whether
   typed, made with escapes such as \.5c! or sent as WXF, and results holding it get no picture
   or TeX. *)
$boxSyntax = "\\!" | "\\(" | "\\*";
boxStringQ[held_HoldComplete] := AnyTrue[withKeys[held], !FreeQ[#, s_String /; StringContainsQ[s, $boxSyntax]] &];

(* a String request is Wolfram Language input: parse it without evaluating anything *)
parse[HoldComplete[s_String]] := Which[
  StringContainsQ[s, "\\!"], failure["Syntax", "Box input (\\!) is not accepted."],
  True, Block[{$Context = "Global`", $ContextPath = {"System`", "Global`"}},
    Replace[Quiet @ ToExpression[s, InputForm, HoldComplete], {
      h_HoldComplete :> h,
      _ :> failure["Syntax", "The input could not be parsed."]}]]];
parse[held_HoldComplete] := held;

(* one line per message, arguments in InputForm: "Power::infy: Infinite expression 1/0 encountered." *)
argText[HoldCompleteForm[e_]] := ToString[Unevaluated[e], InputForm];
argText[e_] := ToString[e, InputForm];
messageText[Hold[Message[MessageName[s_Symbol, tag_String], args___]]] := Quiet @ Module[
  {name = SymbolName[Unevaluated[s]] <> "::" <> tag, template = MessageName[s, tag], texts = argText /@ {args}},
  If[!StringQ[template], template = MessageName[General, tag]];
  name <> ": " <> If[StringQ[template], ToString[StringForm[template, Sequence @@ texts]], StringRiffle[texts, " "]]];
messageText[other_] := ToString[other, InputForm];

(* Image of graphics or text would be drawn by the front end during the evaluation, outside the
   kernel's memory limit: during an evaluation, Image takes pixel data only (arrays of numbers,
   images, and the Raster of ComplexPlot). The calls that the built-in Image makes itself are not
   checked. *)
General::wsbimage = "Image takes an array of numbers or an image here; graphics and text are not rasterized.";
pixelsQ[x_] := ArrayQ[x, 2 | 3, NumericQ] || NumericArrayQ[x];
SetAttributes[restricted, HoldFirst];
restricted[e_] := Internal`InheritedBlock[{Image},
  Unprotect[Image];
  Image[x_, rest___] /; !TrueQ[$inImage] := Block[{$inImage = True},
    If[pixelsQ[x] || ImageQ[x] || MatchQ[x, Raster[_?pixelsQ, ___]],
      With[{image = Image[x, rest]}, If[ImageQ[image], image, $Failed]],
      Message[Image::wsbimage]; $Failed]];
  Protect[Image];
  e];

(* How a result is shown on a web page: graphics as an SVG picture (PNG for raster images),
   everything else as TeX for KaTeX. Formatting runs under its own time limit after the
   evaluation and never fails a request: when it does not work, the reply has neither field. *)
$graphics = _Graphics | _Graphics3D | _Legended | _GraphicsRow | _GraphicsColumn | _GraphicsGrid | _Graph | _Image;
$texLimit = 20000;     (* longest TeX sent; longer results are shown as InputForm only *)
$svgLimit = 500000;    (* larger SVGs (dense contour or density plots) become a PNG inside an SVG *)
(* The front end draws the pictures, and MemoryConstrained does not count its memory. Pictures
   are made only of results of at most $graphicsLimit leaves, of which at most $texLimit outside
   the graphics, with no ImageSize above $imageSizeLimit points, and of at most $pixelLimit pixels. *)
$graphicsLimit = 10^6;
$imageSizeLimit = 2000;
$pixelLimit = 16*10^6;

display[result_Image] := If[Times @@ ImageDimensions[result] > $pixelLimit, <||>,
  imageData["PNG", ExportByteArray[result, "PNG"]]];
display[result_ /; !FreeQ[result, $graphics]] := If[pictureQ[result], imageData["SVG", svg[result]], <||>];   (* also {plot1, plot2} *)
display[result_] := If[LeafCount[result] > $texLimit, <||>,
  With[{t = tex[result]}, If[StringQ[t] && StringLength[t] <= $texLimit, <|"TeX" -> t|>, <||>]]];
imageData[format_, data_] := If[StringQ[data] || ByteArrayQ[data], <|"Image" -> <|"Format" -> format, "Data" -> data|>|>, <||>];

pictureQ[result_] := LeafCount[result] <= $graphicsLimit &&
  LeafCount[inside[result, $graphics -> 0]] <= $texLimit &&
  FreeQ[result, (Rule | RuleDelayed)[ImageSize | "ImageSize", size_] /; !FreeQ[size,
    n_ /; (NumericQ[n] && TrueQ[Abs[n] > $imageSizeLimit]) || MatchQ[n, _DirectedInfinity]]];

(* Cairo draws a dense mesh of polygons as megabytes of paths with hairline seams between them;
   such a picture is sent as a PNG at twice the resolution, wrapped in an SVG of the same size *)
svg[g_] := Module[{s, pixels, image, png, w, h},
  $frontEndUsed = True;
  s = ExportString[g, "SVG"];
  (* a kernel whose export machinery was broken by an earlier abort fails every export *)
  If[!StringQ[s] && !StringQ[Quiet @ ExportString[Graphics[], "SVG"]], $restart = True];
  If[!StringQ[s] || StringLength[s] <= $svgLimit, Return[s]];
  pixels = StringCases[StringTake[s, UpTo[1000]],
    "<svg" ~~ Shortest[___] ~~ " width=\"" ~~ a : NumberString ~~ "pt\"" ~~ Shortest[___] ~~ " height=\"" ~~ b : NumberString ~~ "pt\"" :>
      4 * ToExpression[a] * ToExpression[b], 1];
  If[!MatchQ[pixels, {p_ /; p <= $pixelLimit}], Return[s]];
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

(* formatting after the evaluation: its own time limit, and the memory that the result leaves free *)
SetAttributes[limited, HoldFirst];
limited[e_, memory_] := CheckAbort[Quiet @ TimeConstrained[MemoryConstrained[e, Max[0, memory], $memoryExceeded],
  WSBridge`$FormatTimeLimit, $timeExceeded], $Aborted];

(* An abort in the middle of an export leaves this kernel unable to export anything again (Export
   returns Null at once, also with a new front end). Serve then tells the bridge to replace the
   kernel, sends the reply and exits. *)
$restart = False;

run[held_HoldComplete] := Module[{data, result, size, free, start, text, shown},
  (* a fresh $MessageList per request: the kernel lives on between requests, and a message
     already seen three times would otherwise stay suppressed by General::stop *)
  data = With[{h = held}, Block[{$MessageList = {}}, EvaluationData[
    TimeConstrained[MemoryConstrained[restricted[ReleaseHold[h]], WSBridge`$MemoryLimit, $memoryExceeded], WSBridge`$TimeLimit, $timeExceeded]]]];
  result = data["Result"];
  Which[
    result === $timeExceeded, failure["TimeLimit", "The evaluation took longer than " <> ToString[WSBridge`$TimeLimit] <> " s."],
    result === $memoryExceeded, failure["MemoryLimit", "The evaluation needed more than " <> ToString[WSBridge`$MemoryLimit] <> " bytes."],
    True,
    size = ByteCount[result];
    free = WSBridge`$MemoryLimit - size;
    (* an abort that arrives late, from the evaluation's own limits, costs only the picture or TeX *)
    $frontEndUsed = False;
    start = AbsoluteTime[];
    shown = If[boxStringQ[With[{r = result}, HoldComplete[r]]], <||>, limited[display[result], free]];
    If[!AssociationQ[shown],
      (* the time limit can also reach a front end call as an abort *)
      shown = <|"Format" -> Which[shown === $memoryExceeded, "MemoryLimit",
        shown === $timeExceeded || AbsoluteTime[] - start >= WSBridge`$FormatTimeLimit, "TimeLimit", True, "Aborted"]|>;
      If[$frontEndUsed, $restart = True]];
    text = If[size > WSBridge`$ResultLimit && !MatchQ[result, $graphics], $Failed, limited[resultText[result], free]];
    If[!StringQ[text], text = "-LargeResult-"];
    If[StringLength[text] > WSBridge`$OutputLimit, text = StringTake[text, WSBridge`$OutputLimit] <> " (...)"];
    Join[<|"Success" -> True|>,
      If[size > WSBridge`$ResultLimit, <||>, <|"Result" -> result|>],
      <|"InputForm" -> text, "Messages" -> (messageText /@ data["MessagesExpressions"]), "Timing" -> data["AbsoluteTiming"]|>,
      shown]]];

(* Reading a request creates the symbols it names that do not exist yet: BinaryDeserialize reads
   a name without a context as System`name (it ignores $Context) and takes any name in any
   context, also ones that typed input cannot form ("a b", "*"); ToExpression creates the symbols
   of typed input. A System` symbol left behind would change how later requests are read (typed
   x would mean a refused System`x, and Global`x would clash with it), and one in a package's
   context could stand in for a symbol of that package when it loads. So the symbols created
   while a request is read are collected, as {context, name}; a request that created any outside
   Global` is refused (an unknown System` name is not a variable), and the symbols created by a
   request that is not evaluated are removed again. Those of an evaluated request are Global`
   variables, removed once its reply is sent (Serve), so that many distinct names do not pile up
   in the kernel. Global` symbols never shadow System` ones: typed input looks in System` first.
   Reading stops at the symbol after the first $symbolLimit new ones, which bounds both the
   symbols to remove and the work done outside the time limit. *)
$symbolLimit = 10000;
SetAttributes[newSymbols, HoldFirst];
newSymbols[e_] := Module[{count = 0}, Replace[
  Reap[Catch[Block[{$NewSymbol = (Sow[{#2, #1}, newSymbols]; If[++count > $symbolLimit, Throw[$tooMany, newSymbols]]) &}, e], newSymbols], newSymbols],
  {r_, created_} :> {r, DeleteDuplicates @ Flatten[created, 1]}]];

(* Remove of a string takes it as a pattern, and System`* is a symbol that WXF can make, so the
   symbols are taken from one WXF list of their names instead (a string's WXF with the symbol type
   byte). A System` name goes without its context ("System`*" does not decode, "*" does), except
   the empty name, which only "System`" gives. Only symbols with nothing defined are removed:
   never one that has been given anything, e.g. by a package loaded meanwhile. *)
wxfName[{"System`", name_ /; name =!= ""}] := name;
wxfName[{context_, name_}] := context <> name;
varint[n_] := With[{d = Reverse[IntegerDigits[n, 128]]}, Join[BitOr[Most[d], 128], {Last[d]}]];
symbolsWXF[pairs_] := With[{codes = ToCharacterCode[wxfName /@ pairs, "UTF-8"]},
  ByteArray[Join[{56, 58, 102}, varint[Length[codes]], {115, 4}, ToCharacterCode["List"],
    Flatten[{115, varint[Length[#]], #} & /@ codes]]]];
removeSymbols[{}] := Null;
removeSymbols[list_List] := Module[{pairs = DeleteDuplicates[list], wanted, held},
  wanted = AssociationThread[pairs -> True];
  held = Quiet @ BinaryDeserialize[symbolsWXF[pairs], HoldComplete];
  If[!MatchQ[held, HoldComplete[_List]],
    (* one name that does not decode spoils the list: then each on its own *)
    If[Length[pairs] > 1, Scan[removeSymbols[{#}] &, pairs]]; Return[Null]];
  Replace[Join @@ Cases[held, s_Symbol /; Quiet[KeyExistsQ[wanted, {Context[Unevaluated[s]], SymbolName[Unevaluated[s]]}]] &&
      emptyQ[s] :> HoldComplete[s], {2}],
    HoldComplete[s___] :> Quiet[Remove[s]]];];
(* a name in two contexts gets the message s::shdw when the second one is made *)
SetAttributes[emptyQ, HoldFirst];
emptyQ[s_Symbol] := Attributes[s] === {} && OwnValues[s] === {} && DownValues[s] === {} &&
  UpValues[s] === {} && SubValues[s] === {} && FormatValues[s] === {} &&
  MatchQ[Messages[s], {(Verbatim[HoldPattern][HoldPattern[MessageName[_, "shdw"]]] :> _) ...}];
(* the new variables of the last evaluated request, which Serve removes after its reply *)
$created = {};

(* a HoldComplete, or a failure; a name in two contexts (Global`x and a new System`x) is not one *)
read[bytes_] := With[{held = Quiet @ Check[Quiet[BinaryDeserialize[bytes, HoldComplete], General::shdw], $Failed]},
  If[MatchQ[held, _HoldComplete], parse[held], failure["Decode", "The request is not valid WXF."]]];

(* the failure that refuses a request, or None *)
refusal[$tooMany, _] := failure["NotAllowed",
  "The request names more than " <> IntegerString[$symbolLimit] <> " symbols that do not exist yet."];
refusal[held_, created_] := Module[{new = Cases[created, {c_, n_} /; c =!= "Global`" :> c <> n], bad},
  If[AssociationQ[held], Return[held]];
  bad = Union[refused[held], new];
  Which[
    bad =!= {}, failure["NotAllowed", "The request uses symbols that are not allowed." <>
      If[MemberQ[created, {"System`", _}], " A System` symbol that does not exist is not a variable; " <>
        "in WXF a name without a context is in System`: send variables as Global`name.", ""],
      <|"Symbols" -> bad|>],
    boxStringQ[held], failure["NotAllowed", "Strings with box syntax (\\!, \\(, \\*) are not accepted."],
    True, None]];

EvaluateRequest[bytes_ByteArray] := Module[{held, created, refuse},
  {held, created} = newSymbols[read[bytes]];
  refuse = refusal[held, created];
  If[refuse =!= None, removeSymbols[created]; Return[refuse]];
  $created = Join[$created, created];
  run[held]];
EvaluateRequest[_] := failure["Decode", "The request must be a ByteArray."];

(* The request loop. Every step runs under CheckAbort: an abort that arrives late, after a
   TimeConstrained has already returned, must not end the loop. *)
Serve[endpoint_String] := Module[{socket, request, reply},
  socket = SocketConnect[endpoint, "ZMQ_Pair"];
  If[FailureQ[socket], Print["cannot connect to ", endpoint]; Exit[3]];
  (* the first SVG and PNG exports and TeXForm of a session take seconds: pay that before "ready" *)
  Quiet[ExportString[Plot[x, {x, 0, 1}], "SVG"]; ExportByteArray[Image[{{0., 1.}}], "PNG"]; ToString[TeXForm[Sqrt[x]/2]]];
  SocketWriteMessage[socket, StringToByteArray["ready"]];
  While[True,
    request = CheckAbort[SocketReadMessage[socket], $Aborted];
    If[!ByteArrayQ[request], Continue[]];
    reply = CheckAbort[EvaluateRequest[request], failure["Aborted", "The evaluation was aborted."]];
    reply = CheckAbort[BinarySerialize[reply],
      BinarySerialize[failure["Aborted", "The reply could not be serialized."]]];
    (* "restart" comes before the reply, so that the bridge knows before it sends another request *)
    AbortProtect[If[$restart, SocketWriteMessage[socket, StringToByteArray["restart"]]]; SocketWriteMessage[socket, reply]];
    If[$restart, Quiet[Close[socket]]; Exit[0]];
    (* the reply is sent: the variables that its request created can go *)
    CheckAbort[removeSymbols[$created], Null];
    $created = {}]];

End[];
EndPackage[];
