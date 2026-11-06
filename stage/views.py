import json
from django.shortcuts import render, get_object_or_404, redirect
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from django.db import transaction
from .models import SongProject, Section, Measure


@ensure_csrf_cookie
def studio_view(request, project_id=None):
    if project_id:
        project = get_object_or_404(SongProject, id=project_id)
        sections = [
            {
                "id": s.id,
                "startBar": s.start_bar,
                "name": s.name,
                "color": getattr(s, 'color', '#facc15'),
                "isNewSong": getattr(s, 'is_new_song', False),
                "songTitle": getattr(s, 'song_title', '') or project.title,
                "songKey": s.song_key
            }
            for s in project.sections.all()
        ]
        measures = [
            {
                "bar": m.bar_index,
                "chordLine": m.chord_line,
                "leadLine": m.lead_line
            }
            for m in project.measures.all()
        ]
        timing_points = project.timing_points if (project.timing_points and len(project.timing_points) > 0) else [
            {
                "id": 1,
                "offset": 0.0,
                "bpm": project.bpm,
                "beatsPerBar": project.beats_per_bar
            }
        ]
        initial_data = {
            "projectId": project.id,
            "title": project.title,
            "key": project.default_key,
            "bpm": project.bpm,
            "beatsPerBar": project.beats_per_bar,
            "totalMeasures": project.total_measures,
            "isLocked": bool(project.edit_pin),
            "audioUrl": project.audio_file.url if project.audio_file else None,
            "sections": sections if sections else [
                {"id": 1, "startBar": 1, "name": "Section 1", "color": "#facc15", "isNewSong": True, "songTitle": project.title, "songKey": project.default_key}
            ],
            "timingPoints": timing_points,
            "measures": measures if measures else [
                {"bar": i, "chordLine": "", "leadLine": ""} for i in range(1, project.total_measures + 1)
            ]
        }
    else:
        default_bars = 8
        initial_data = {
            "projectId": None,
            "title": "UNTITLED PROJECT",
            "key": "C",
            "bpm": 120.0,
            "beatsPerBar": 4,
            "totalMeasures": default_bars,
            "isLocked": False,
            "audioUrl": None,
            "sections": [
                {
                    "id": 1,
                    "startBar": 1,
                    "name": "Section 1",
                    "color": "#facc15",
                    "isNewSong": True,
                    "songTitle": "UNTITLED PROJECT",
                    "songKey": "C"
                }
            ],
            "timingPoints": [
                {
                    "id": 1,
                    "offset": 0.0,
                    "bpm": 120.0,
                    "beatsPerBar": 4
                }
            ],
            "measures": [
                {"bar": i, "chordLine": "", "leadLine": ""} for i in range(1, default_bars + 1)
            ]
        }

    return render(request, 'stage/studio.html', {
        'initial_project_data': initial_data
    })


@csrf_exempt
@require_POST
def save_project_api(request, project_id=None):
    """Saves or updates project state from client JSON or FormData with optional audio upload."""
    if request.FILES or 'project_data' in request.POST:
        project_data_raw = request.POST.get('project_data', '{}')
        try:
            data = json.loads(project_data_raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Invalid JSON in project_data"}, status=400)
        uploaded_audio = request.FILES.get('audio_file')
    else:
        try:
            data = json.loads(request.body.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Invalid JSON"}, status=400)
        uploaded_audio = None

    # 1. PIN verification for existing projects
    if project_id:
        project = get_object_or_404(SongProject, id=project_id)
        provided_pin = data.get("pin")
        
        # If the project has an edit_pin set and provided pin doesn't match
        if project.edit_pin and project.edit_pin != provided_pin:
            return JsonResponse({
                "status": "locked",
                "error": "This song is protected. Incorrect edit PIN."
            }, status=403)
    else:
        project = SongProject()

    with transaction.atomic():
        project.title = data.get("title", getattr(project, "title", "UNTITLED PROJECT")).upper()
        project.default_key = data.get("key", getattr(project, "default_key", "C")).upper()
        project.total_measures = int(data.get("totalMeasures", getattr(project, "total_measures", 8)))

        timing_points_data = data.get("timingPoints", [])
        if isinstance(timing_points_data, list) and len(timing_points_data) > 0:
            project.timing_points = timing_points_data
            first_tp = timing_points_data[0]
            project.bpm = float(first_tp.get("bpm", data.get("bpm", getattr(project, "bpm", 120.0))))
            project.beats_per_bar = int(first_tp.get("beatsPerBar", data.get("beatsPerBar", getattr(project, "beats_per_bar", 4))))
        else:
            project.bpm = float(data.get("bpm", getattr(project, "bpm", 120.0)))
            if "beatsPerBar" in data:
                project.beats_per_bar = int(data["beatsPerBar"])
        
        # Optional: set, update, or remove PIN
        if "setPin" in data:
            project.edit_pin = str(data["setPin"]).strip() if data["setPin"] else None

        if uploaded_audio:
            project.audio_file = uploaded_audio

        project.save()

        # Re-sync sections
        project.sections.all().delete()
        sections_data = data.get("sections", [])
        sections_to_create = []
        for idx, sec in enumerate(sections_data):
            start_b = int(sec.get("startBar", 1))
            end_b = int(sec.get("endBar", start_b))
            sections_to_create.append(
                Section(
                    project=project,
                    name=sec.get("name", f"Section {idx+1}"),
                    start_bar=start_b,
                    end_bar=end_b,
                    song_key=sec.get("songKey", project.default_key),
                    color=sec.get("color", "#facc15"),
                    is_new_song=bool(sec.get("isNewSong", False)),
                    song_title=sec.get("songTitle", ""),
                    order=idx
                )
            )
        Section.objects.bulk_create(sections_to_create)

        # Re-sync measures
        project.measures.all().delete()
        measures_data = data.get("measures", [])
        measures_to_create = []
        for idx, m in enumerate(measures_data):
            b_idx = m.get("barIndex") or m.get("bar") or (idx + 1)
            measures_to_create.append(
                Measure(
                    project=project,
                    bar_index=int(b_idx),
                    chord_line=m.get("chordLine", ""),
                    lead_line=m.get("leadLine", "")
                )
            )
        Measure.objects.bulk_create(measures_to_create)

    return JsonResponse({
        "status": "saved",
        "projectId": project.id,
        "audioUrl": project.audio_file.url if project.audio_file else None
    })


@csrf_exempt
@require_POST
def upload_audio_api(request, project_id):
    """Uploads and associates an audio track with an existing project."""
    project = get_object_or_404(SongProject, id=project_id)
    audio_file = request.FILES.get('audio_file')
    if not audio_file:
        return JsonResponse({"error": "No audio file provided"}, status=400)

    project.audio_file = audio_file
    project.save(update_fields=['audio_file', 'updated_at'])
    return JsonResponse({
        "status": "uploaded",
        "projectId": project.id,
        "audioUrl": project.audio_file.url if project.audio_file else None
    })


@require_GET
def load_project_api(request, project_id):
    """Returns project metadata, sections, and measures as JSON."""
    project = get_object_or_404(SongProject, id=project_id)
    
    sections_data = [
        {
            "id": s.id,
            "name": s.name,
            "startBar": s.start_bar,
            "endBar": getattr(s, "end_bar", s.start_bar),
            "color": getattr(s, "color", "#facc15"),
            "isNewSong": getattr(s, "is_new_song", False),
            "songTitle": getattr(s, "song_title", ""),
            "songKey": s.song_key
        } for s in project.sections.all()
    ]
    
    measures_data = [
        {
            "bar": m.bar_index,
            "barIndex": m.bar_index,
            "chordLine": m.chord_line,
            "leadLine": m.lead_line
        } for m in project.measures.all()
    ]

    timing_points = project.timing_points if (project.timing_points and len(project.timing_points) > 0) else [
        {
            "id": 1,
            "offset": 0.0,
            "bpm": project.bpm,
            "beatsPerBar": project.beats_per_bar
        }
    ]

    return JsonResponse({
        "status": "ok",
        "project": {
            "id": project.id,
            "title": project.title,
            "key": project.default_key,
            "bpm": project.bpm,
            "beatsPerBar": project.beats_per_bar,
            "totalMeasures": project.total_measures,
            "isLocked": bool(project.edit_pin),
            "audioUrl": project.audio_file.url if project.audio_file else None,
            "timingPoints": timing_points,
            "sections": sections_data,
            "measures": measures_data
        }
    })


@require_GET
def api_list_projects(request):
    """Returns a list of all saved song projects."""
    projects = (
        SongProject.objects.all()
        .order_by('-updated_at')
        .values('id', 'title', 'default_key', 'bpm', 'total_measures', 'updated_at')
    )
    return JsonResponse({"projects": list(projects)})


@csrf_exempt
def delete_project_api(request, project_id):
    """Deletes a song project. Returns JSON if requested via AJAX/fetch, otherwise redirects to /"""
    try:
        project = SongProject.objects.filter(id=project_id).first()
        if project:
            project.delete()
    except Exception as e:
        print("Delete error:", e)

    if request.headers.get('x-requested-with') == 'XMLHttpRequest' or 'application/json' in request.headers.get('accept', ''):
        return JsonResponse({"status": "deleted", "projectId": project_id})

    # Standard browser click on an <a> tag will redirect right to /
    return redirect('/')
